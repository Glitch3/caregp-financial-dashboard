import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import Papa from "papaparse";

export class App extends DurableObject {
  private app = new Hono();

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    
    this.app.get("/api/sheet-data", async (c) => {
      const gid = c.req.query("gid") || "192931357";
      const sheetId = "1w3-mO9ePQXDlVNhjTAHCbnxo3LPVYdTsymeeUngUO_4";
      const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
      
      try {
        const res = await fetch(exportUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        });
        
        if (!res.ok) {
          return c.json({ error: `Google sheet responded with status ${res.status}`, status: res.status }, 400);
        }
        
        const csvText = await res.text();
        const parsed = Papa.parse(csvText, {
          header: false,
          skipEmptyLines: true
        });
        
        return c.json({
          gid,
          rowCount: parsed.data.length,
          data: parsed.data,
          rawCsvSample: csvText.slice(0, 1000)
        });
      } catch (err: any) {
        return c.json({ error: err?.message || String(err) }, 500);
      }
    });

    this.app.get("/api/health", (c) => c.json({ status: "ok", time: new Date().toISOString() }));
  }

  async fetch(request: Request) {
    return this.app.fetch(request);
  }
}
