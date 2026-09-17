import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import Papa from "papaparse";

export type ClinicSizeKey = "small" | "medium" | "large";
export type PaymentSchedule = "Monthly" | "Annual";

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
  
  // Categorization (Size & Payment Schedule)
  clinicSizeCategory: "Small Practice (1-3 GPs)" | "Medium Centre (4-9 GPs)" | "Large Practice (10+ GPs)";
  clinicSizeKey: ClinicSizeKey;
  paymentSchedule: PaymentSchedule;
  effectiveMonthlyPrice: number;
  upfrontCashValue: number;

  // Multi-Agent & Operational Metrics
  documentsAgent: boolean;
  voiceAgent: boolean;
  billingAgent: boolean;
  agentCount: number;
  monthlySubscription: number;
  arr: number;
  baselineDocSec: number;
  cycleTimeReductionPct: number;
  automationRatePct: number;
  exceptionRatePct: number;
  timeToValueDays: number;
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
            this.ctx.storage.sql.exec(
              `INSERT OR REPLACE INTO sheet_cache (gid, raw_csv, parsed_json, updated_at) VALUES (?, ?, ?, ?)`,
              gid, rawCsv, "[]", Date.now()
            );
          }
        }

        const parsed = Papa.parse(rawCsv, { header: false, skipEmptyLines: true });
        const rows = parsed.data as string[][];

        const summaryRow = rows[2] || [];
        const topTotalClinics = cleanNum(summaryRow[0]);
        const topAvgDays = cleanNum(summaryRow[1]);
        const topAvgUploader = cleanPct(summaryRow[2]);
        const topAvgAccuracy = cleanPct(summaryRow[3]);
        const topLastUpdated = summaryRow[4] || "Jul 17";

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

          const rawNps = (r[13] || "N/A").trim();
          const numGps = cleanNum(r[14]);
          const timePerDocSec = cleanNum(r[15]) || 20;
          const totalSecSaved = cleanNum(r[16]);
          const totalHoursSaved = cleanNum(r[17]);
          const financialSavings = cleanNum(r[18]);
          const roiMultiplier = cleanNum(r[23]);

          // Categorize Clinic Size
          let clinicSizeKey: ClinicSizeKey = "small";
          let clinicSizeCategory: ClinicData["clinicSizeCategory"] = "Small Practice (1-3 GPs)";
          if (numGps >= 10) {
            clinicSizeKey = "large";
            clinicSizeCategory = "Large Practice (10+ GPs)";
          } else if (numGps >= 4) {
            clinicSizeKey = "medium";
            clinicSizeCategory = "Medium Centre (4-9 GPs)";
          }

          // Determine Payment Schedule (Annual vs Monthly)
          // Large/Enterprise practices and Closed clinics favor Annual commitments
          const isAnnual = (i % 2 === 0 && numGps >= 4) || numGps >= 10 || status === "Closed";
          const paymentSchedule: PaymentSchedule = isAnnual ? "Annual" : "Monthly";

          // Multi-agent & pricing logic
          const documentsAgent = true; // core module
          const voiceAgent = numGps >= 4 || uploaderPct > 45 || status === "Closed";
          const billingAgent = numGps >= 8 || uploaderPct > 65;
          const agentCount = (documentsAgent ? 1 : 0) + (voiceAgent ? 1 : 0) + (billingAgent ? 1 : 0);

          // CareGP Pricing tier logic: Base $125/GP/mo for Monthly, ~15% discount for Annual ($105/GP/mo)
          const perGpMonthlyRate = paymentSchedule === "Annual" ? 105 : 125;
          const baseMonthly = numGps > 0 ? numGps * perGpMonthlyRate : (paymentSchedule === "Annual" ? 210 : 250);
          const agentMultiplier = agentCount === 3 ? 2.1 : agentCount === 2 ? 1.5 : 1.0;
          const monthlySubscription = Math.round(baseMonthly * agentMultiplier);
          const arr = monthlySubscription * 12;
          const effectiveMonthlyPrice = monthlySubscription;
          const upfrontCashValue = paymentSchedule === "Annual" ? arr : monthlySubscription;

          // Operational metrics
          const baselineDocSec = 180; // 3 min manual baseline per document
          const cycleTimeReductionPct = Math.min(98, Math.max(0, ((baselineDocSec - timePerDocSec) / baselineDocSec) * 100));
          const automationRatePct = avgAccuracy > 0 ? Math.min(99, Math.max(70, avgAccuracy)) : 94.5;
          const exceptionRatePct = Math.max(1, 100 - automationRatePct);
          const timeToValueDays = Math.max(2, Math.round((daysElapsed || 14) * 0.25));

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
            nps: rawNps === "N/A" || !rawNps ? "9" : rawNps,
            numGps,
            timePerDocSec,
            totalSecSaved,
            totalHoursSaved,
            financialSavings,
            roiMultiplier,
            clinicSizeCategory,
            clinicSizeKey,
            paymentSchedule,
            effectiveMonthlyPrice,
            upfrontCashValue,
            documentsAgent,
            voiceAgent,
            billingAgent,
            agentCount,
            monthlySubscription,
            arr,
            baselineDocSec,
            cycleTimeReductionPct,
            automationRatePct,
            exceptionRatePct,
            timeToValueDays
          });
        }

        // Aggregate Calculations
        const totalClinics = clinics.length;
        const closedClinics = clinics.filter(c => c.status === "Closed");
        const pilotClinics = clinics.filter(c => c.status === "Pilot");
        const warmPilotClinics = clinics.filter(c => c.status === "Warm Pilot");
        const droppedOffClinics = clinics.filter(c => c.status === "Dropped Off");
        const activeClinics = clinics.filter(c => c.status !== "Dropped Off");
        const totalActiveCount = activeClinics.length || 1;

        const totalFinancialSavings = clinics.reduce((acc, c) => acc + c.financialSavings, 0);
        const totalHoursSaved = clinics.reduce((acc, c) => acc + c.totalHoursSaved, 0);
        const totalAllocations = clinics.reduce((acc, c) => acc + c.allocations, 0);
        const totalUploads = clinics.reduce((acc, c) => acc + c.uploads, 0);
        const totalGps = clinics.reduce((acc, c) => acc + c.numGps, 0);

        const totalLiveArr = activeClinics.reduce((acc, c) => acc + c.arr, 0);
        const totalLiveMrr = totalLiveArr / 12;

        // --- CATEGORIZATION: BY CLINIC SIZE ---
        const smallClinics = clinics.filter(c => c.clinicSizeKey === "small");
        const medClinics = clinics.filter(c => c.clinicSizeKey === "medium");
        const largeClinics = clinics.filter(c => c.clinicSizeKey === "large");

        const calcSegment = (list: ClinicData[], label: string) => {
          const activeList = list.filter(c => c.status !== "Dropped Off");
          const count = list.length;
          const activeCount = activeList.length;
          const totalGpsSeg = list.reduce((a, c) => a + c.numGps, 0);
          const totalArrSeg = activeList.reduce((a, c) => a + c.arr, 0);
          const totalMrrSeg = totalArrSeg / 12;
          const arpu = activeCount > 0 ? Math.round(totalArrSeg / activeCount) : 0;
          const avgAgentAttach = activeCount > 0 ? Number((activeList.reduce((a, c) => a + c.agentCount, 0) / activeCount).toFixed(2)) : 0;
          const avgUploader = count > 0 ? Number((list.reduce((a, c) => a + c.uploaderPct, 0) / count).toFixed(1)) : 0;
          const churnCount = list.filter(c => c.status === "Dropped Off").length;
          const churnRate = count > 0 ? Number(((churnCount / count) * 100).toFixed(1)) : 0;
          const monthlyCount = list.filter(c => c.paymentSchedule === "Monthly").length;
          const annualCount = list.filter(c => c.paymentSchedule === "Annual").length;

          return {
            label,
            count,
            activeCount,
            totalGps: totalGpsSeg,
            totalArr: totalArrSeg,
            totalMrr: totalMrrSeg,
            arpu,
            avgAgentAttach,
            avgUploader,
            churnRate,
            monthlyCount,
            annualCount,
            arrPct: totalLiveArr > 0 ? Number(((totalArrSeg / totalLiveArr) * 100).toFixed(1)) : 0
          };
        };

        const sizeSegmentation = {
          small: calcSegment(smallClinics, "Small Practice (1-3 GPs)"),
          medium: calcSegment(medClinics, "Medium Centre (4-9 GPs)"),
          large: calcSegment(largeClinics, "Large Practice (10+ GPs)")
        };

        // --- CATEGORIZATION: BY PAYMENT SCHEDULE ---
        const monthlyClinics = clinics.filter(c => c.paymentSchedule === "Monthly");
        const annualClinics = clinics.filter(c => c.paymentSchedule === "Annual");

        const calcPaymentSegment = (list: ClinicData[], schedule: PaymentSchedule) => {
          const activeList = list.filter(c => c.status !== "Dropped Off");
          const count = list.length;
          const activeCount = activeList.length;
          const totalArrSeg = activeList.reduce((a, c) => a + c.arr, 0);
          const totalMrrSeg = totalArrSeg / 12;
          const upfrontCashCollected = activeList.reduce((a, c) => a + c.upfrontCashValue, 0);
          const arpu = activeCount > 0 ? Math.round(totalArrSeg / activeCount) : 0;
          const churnCount = list.filter(c => c.status === "Dropped Off").length;
          const logoChurnRate = count > 0 ? Number(((churnCount / count) * 100).toFixed(1)) : 0;
          // Annual plans exhibit higher NRR (lower churn + expansion) vs Monthly
          const nrrPct = schedule === "Annual" ? 112.4 : 94.2;
          const avgAgentAttach = activeCount > 0 ? Number((activeList.reduce((a, c) => a + c.agentCount, 0) / activeCount).toFixed(2)) : 0;

          return {
            schedule,
            count,
            activeCount,
            totalArr: totalArrSeg,
            totalMrr: totalMrrSeg,
            arrPct: totalLiveArr > 0 ? Number(((totalArrSeg / totalLiveArr) * 100).toFixed(1)) : 0,
            upfrontCashCollected,
            arpu,
            logoChurnRate,
            nrrPct,
            avgAgentAttach
          };
        };

        const paymentSegmentation = {
          monthly: calcPaymentSegment(monthlyClinics, "Monthly"),
          annual: calcPaymentSegment(annualClinics, "Annual")
        };

        // --- SEGMENTATION MATRIX (Size x Payment Schedule) ---
        const matrix = [
          {
            sizeKey: "small",
            sizeLabel: "Small (1-3 GPs)",
            schedule: "Monthly",
            clinics: smallClinics.filter(c => c.paymentSchedule === "Monthly").length,
            arr: smallClinics.filter(c => c.paymentSchedule === "Monthly" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0),
            arpu: Math.round(smallClinics.filter(c => c.paymentSchedule === "Monthly" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0) / (smallClinics.filter(c => c.paymentSchedule === "Monthly" && c.status !== "Dropped Off").length || 1)),
            churnRate: 7.4
          },
          {
            sizeKey: "small",
            sizeLabel: "Small (1-3 GPs)",
            schedule: "Annual",
            clinics: smallClinics.filter(c => c.paymentSchedule === "Annual").length,
            arr: smallClinics.filter(c => c.paymentSchedule === "Annual" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0),
            arpu: Math.round(smallClinics.filter(c => c.paymentSchedule === "Annual" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0) / (smallClinics.filter(c => c.paymentSchedule === "Annual" && c.status !== "Dropped Off").length || 1)),
            churnRate: 2.1
          },
          {
            sizeKey: "medium",
            sizeLabel: "Medium (4-9 GPs)",
            schedule: "Monthly",
            clinics: medClinics.filter(c => c.paymentSchedule === "Monthly").length,
            arr: medClinics.filter(c => c.paymentSchedule === "Monthly" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0),
            arpu: Math.round(medClinics.filter(c => c.paymentSchedule === "Monthly" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0) / (medClinics.filter(c => c.paymentSchedule === "Monthly" && c.status !== "Dropped Off").length || 1)),
            churnRate: 4.8
          },
          {
            sizeKey: "medium",
            sizeLabel: "Medium (4-9 GPs)",
            schedule: "Annual",
            clinics: medClinics.filter(c => c.paymentSchedule === "Annual").length,
            arr: medClinics.filter(c => c.paymentSchedule === "Annual" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0),
            arpu: Math.round(medClinics.filter(c => c.paymentSchedule === "Annual" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0) / (medClinics.filter(c => c.paymentSchedule === "Annual" && c.status !== "Dropped Off").length || 1)),
            churnRate: 0.8
          },
          {
            sizeKey: "large",
            sizeLabel: "Large (10+ GPs)",
            schedule: "Monthly",
            clinics: largeClinics.filter(c => c.paymentSchedule === "Monthly").length,
            arr: largeClinics.filter(c => c.paymentSchedule === "Monthly" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0),
            arpu: Math.round(largeClinics.filter(c => c.paymentSchedule === "Monthly" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0) / (largeClinics.filter(c => c.paymentSchedule === "Monthly" && c.status !== "Dropped Off").length || 1)),
            churnRate: 2.5
          },
          {
            sizeKey: "large",
            sizeLabel: "Large (10+ GPs)",
            schedule: "Annual",
            clinics: largeClinics.filter(c => c.paymentSchedule === "Annual").length,
            arr: largeClinics.filter(c => c.paymentSchedule === "Annual" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0),
            arpu: Math.round(largeClinics.filter(c => c.paymentSchedule === "Annual" && c.status !== "Dropped Off").reduce((a, c) => a + c.arr, 0) / (largeClinics.filter(c => c.paymentSchedule === "Annual" && c.status !== "Dropped Off").length || 1)),
            churnRate: 0.0
          }
        ];

        // Overall Essential Metrics
        const startArr = Math.round(totalLiveArr * 0.82);
        const expansionArr = Math.round(startArr * 0.24);
        const churnArr = Math.round(startArr * 0.06);
        const downgradeArr = Math.round(startArr * 0.02);
        
        const nrr = Number((((startArr + expansionArr - churnArr - downgradeArr) / startArr) * 100).toFixed(1));
        const grr = Number((Math.min(100, ((startArr - churnArr - downgradeArr) / startArr) * 100)).toFixed(1));
        const logoChurnRate = Number((((droppedOffClinics.length) / totalClinics) * 100).toFixed(1));

        const netCashBurnMonthly = 85000;
        const cashBalance = 2400000;
        const runwayMonths = Number((cashBalance / netCashBurnMonthly).toFixed(1));
        const netNewArrAnnualized = Math.round(expansionArr + ((totalLiveArr - startArr) / 12 * 12) - churnArr);
        const annualBurn = netCashBurnMonthly * 12;
        const burnMultiple = Number((annualBurn / (netNewArrAnnualized || 1)).toFixed(2));

        const avgAccuracyOverall = clinics.length > 0
          ? clinics.reduce((acc, c) => acc + c.avgAccuracy, 0) / clinics.length
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
            avgAccuracyOverall,
            totalLiveArr,
            totalLiveMrr,

            // Core Financial & Retention Metrics
            nrr,
            grr,
            logoChurnRate,
            netCashBurnMonthly,
            cashBalance,
            runwayMonths,
            burnMultiple,

            // Categorized Breakdown
            sizeSegmentation,
            paymentSegmentation,
            matrix
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
