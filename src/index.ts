import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import Papa from "papaparse";

export interface ClinicData {
  id: string;
  name: string;
  comments: string;
  status: "Closed" | "Pilot" | "Warm Pilot" | "Dropped Off" | string;
  allocations: number;
  uploads: number;
  pilotStartDate: string;
  daysElapsed: number;
  uploaderPct: number;
  bulkImportPct: number;
  accuracyL1: number;
  accuracyL2: number;
  accuracyL3: number;
  accuracyL4: number;
  avgAccuracy: number;
  nps: string;
  numGps: number;
  timePerDocSec: number;
  totalSecSaved: number;
  totalHoursSaved: number;
  financialSavings: number;
  roiMultiplier: number;
}

export class App extends DurableObject {
  private app = new Hono();

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);

    // Initialize database table
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sheet_cache (
        gid TEXT PRIMARY KEY,
        raw_csv TEXT NOT NULL,
        parsed_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.app.get("/api/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

    this.app.get("/api/dashboard", async (c) => {
      const forceRefresh = c.req.query("refresh") === "true";
      const gid = c.req.query("gid") || "192931357";
      
      try {
        let rawCsv = "";
        let isCached = false;
        
        // Check cache unless force refresh
        if (!forceRefresh) {
          const cached = this.ctx.storage.sql
            .exec(`SELECT raw_csv, updated_at FROM sheet_cache WHERE gid = ?`, gid)
            .toArray();
          
          if (cached.length > 0) {
            const row = cached[0] as { raw_csv: string; updated_at: number };
            // Cache valid for 10 minutes
            if (Date.now() - row.updated_at < 10 * 60 * 1000) {
              rawCsv = row.raw_csv;
              isCached = true;
            }
          }
        }

        if (!rawCsv) {
          const sheetId = "1w3-mO9ePQXDlVNhjTAHCbnxo3LPVYdTsymeeUngUO_4";
          const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
          const res = await fetch(exportUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
          });

          if (!res.ok) {
            // If fetch fails but we have stale cache, return stale cache
            const fallback = this.ctx.storage.sql
              .exec(`SELECT raw_csv FROM sheet_cache WHERE gid = ?`, gid)
              .toArray();
            if (fallback.length > 0) {
              rawCsv = (fallback[0] as any).raw_csv;
              isCached = true;
            } else {
              throw new Error(`Google Sheet export returned status ${res.status}`);
            }
          } else {
            rawCsv = await res.text();
            // Cache in SQLite
            this.ctx.storage.sql.exec(
              `INSERT OR REPLACE INTO sheet_cache (gid, raw_csv, parsed_json, updated_at) VALUES (?, ?, ?, ?)`,
              gid, rawCsv, "[]", Date.now()
            );
          }
        }

        const parsed = Papa.parse(rawCsv, { header: false, skipEmptyLines: true });
        const rows = parsed.data as string[][];

        // Process KPIs and clinic rows
        // Row 2 (index 2) contains top summary
        const summaryRow = rows[2] || [];
        const topTotalClinics = cleanNum(summaryRow[0]);
        const topAvgDays = cleanNum(summaryRow[1]);
        const topAvgUploader = cleanPct(summaryRow[2]);
        const topAvgAccuracy = cleanPct(summaryRow[3]);
        const topLastUpdated = summaryRow[4] || "Jul 17";

        // Rows starting from index 4 are clinic data
        const clinics: ClinicData[] = [];
        
        for (let i = 4; i < rows.length; i++) {
          const r = rows[i];
          if (!r || r.length === 0) continue;
          const name = (r[0] || "").trim();
          if (!name || name === "Clinic Name") continue;

          const comments = (r[1] || "").trim();
          const status = (r[2] || "").trim() || "Unknown";
          const allocations = cleanNum(r[3]);
          const uploads = cleanNum(r[4]);
          const pilotStartDate = (r[5] || "").trim();
          const daysElapsed = cleanNum(r[6]);
          const uploaderPct = cleanPct(r[7]);
          const bulkImportPct = cleanPct(r[8]);
          const accuracyL1 = cleanPct(r[9]);
          const accuracyL2 = cleanPct(r[10]);
          const accuracyL3 = cleanPct(r[11]);
          const accuracyL4 = cleanPct(r[12]);
          
          const validAccuracies = [accuracyL1, accuracyL2, accuracyL3, accuracyL4].filter(v => v > 0);
          const avgAccuracy = validAccuracies.length > 0 
            ? validAccuracies.reduce((a, b) => a + b, 0) / validAccuracies.length 
            : 0;

          const nps = (r[13] || "N/A").trim();
          const numGps = cleanNum(r[14]);
          const timePerDocSec = cleanNum(r[15]);
          const totalSecSaved = cleanNum(r[16]);
          const totalHoursSaved = cleanNum(r[17]);
          const financialSavings = cleanNum(r[18]);
          const roiMultiplier = cleanNum(r[23]);

          clinics.push({
            id: `clinic-${i}`,
            name,
            comments,
            status,
            allocations,
            uploads,
            pilotStartDate,
            daysElapsed,
            uploaderPct,
            bulkImportPct,
            accuracyL1,
            accuracyL2,
            accuracyL3,
            accuracyL4,
            avgAccuracy,
            nps,
            numGps,
            timePerDocSec,
            totalSecSaved,
            totalHoursSaved,
            financialSavings,
            roiMultiplier
          });
        }

        // Calculate aggregates
        const totalClinics = clinics.length;
        const closedClinics = clinics.filter(c => c.status === "Closed");
        const pilotClinics = clinics.filter(c => c.status === "Pilot");
        const warmPilotClinics = clinics.filter(c => c.status === "Warm Pilot");
        const droppedOffClinics = clinics.filter(c => c.status === "Dropped Off");

        const totalFinancialSavings = clinics.reduce((acc, c) => acc + c.financialSavings, 0);
        const totalHoursSaved = clinics.reduce((acc, c) => acc + c.totalHoursSaved, 0);
        const totalAllocations = clinics.reduce((acc, c) => acc + c.allocations, 0);
        const totalUploads = clinics.reduce((acc, c) => acc + c.uploads, 0);
        const totalGps = clinics.reduce((acc, c) => acc + c.numGps, 0);

        const avgUploaderPct = clinics.length > 0
          ? clinics.reduce((acc, c) => acc + c.uploaderPct, 0) / clinics.length
          : 0;

        const avgAccuracyOverall = clinics.length > 0
          ? clinics.reduce((acc, c) => acc + c.avgAccuracy, 0) / clinics.length
          : 0;

        const avgTimePerDoc = clinics.filter(c => c.timePerDocSec > 0).length > 0
          ? clinics.filter(c => c.timePerDocSec > 0).reduce((acc, c) => acc + c.timePerDocSec, 0) / clinics.filter(c => c.timePerDocSec > 0).length
          : 0;

        return c.json({
          meta: {
            topTotalClinics,
            topAvgDays,
            topAvgUploader,
            topAvgAccuracy,
            topLastUpdated,
            isCached,
            fetchedAt: new Date().toISOString()
          },
          summary: {
            totalClinics,
            closedCount: closedClinics.length,
            pilotCount: pilotClinics.length,
            warmPilotCount: warmPilotClinics.length,
            droppedOffCount: droppedOffClinics.length,
            totalFinancialSavings,
            totalHoursSaved,
            totalAllocations,
            totalUploads,
            totalGps,
            avgUploaderPct,
            avgAccuracyOverall,
            avgTimePerDoc
          },
          clinics
        });
      } catch (err: any) {
        return c.json({ error: err?.message || String(err) }, 500);
      }
    });
  }

  async fetch(request: Request) {
    return this.app.fetch(request);
  }
}

function cleanNum(val: any): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const str = String(val).replace(/[\$,\s#VALUE!]/g, "").trim();
  if (!str || str === "N/A" || str === "N/A%") return 0;
  const parsed = parseFloat(str);
  return isNaN(parsed) ? 0 : parsed;
}

function cleanPct(val: any): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === "number") return val <= 1 ? val * 100 : val;
  const str = String(val).replace(/[%,\s]/g, "").trim();
  if (!str || str === "N/A") return 0;
  const parsed = parseFloat(str);
  return isNaN(parsed) ? 0 : parsed;
}
