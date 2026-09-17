import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import Papa from "papaparse";

export class App extends DurableObject {
  private app = new Hono();

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    
    // Fetch all tab GIDs from sheet HTML
    this.app.get("/api/tabs", async (c) => {
      const sheetId = "1w3-mO9ePQXDlVNhjTAHCbnxo3LPVYdTsymeeUngUO_4";
      const htmlUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
      try {
        const res = await fetch(htmlUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          }
        });
        const text = await res.text();
        
        // Match sheet names and gids from JavaScript config in the page
        // standard format: sheetId/gid pairs or "name":"SheetName","sheetId":123456
        const tabs: { name: string; gid: string }[] = [];
        
        const matches = text.matchAll(/[\"']sheetName[\"']\s*:\s*[\"']([^\"']+)[\"'][\s\S]*?[\"']sheetId[\"']\s*:\s*(\d+)/g);
        for (const match of matches) {
          tabs.push({ name: match[1], gid: match[2] });
        }

        // Alternative regex if needed
        const matches2 = text.matchAll(/\{\s*\"1\":[^\}]*?\"2\":\"([^\"]+)\"[^\}]*?\"4\":(\d+)/g);
        for (const m of matches2) {
          if (!tabs.some(t => t.gid === String(m[2]))) {
            tabs.push({ name: m[1], gid: String(m[2]) });
          }
        }

        return c.json({ tabs, rawMatchCount: tabs.length });
      } catch (err: any) {
        return c.json({ error: err.message }, 500);
      }
    });

    this.app.get("/api/sheet-data", async (c) => {
      const gid = c.req.query("gid") || "192931357";
      const sheetId = "1w3-mO9ePQXDlVNhjTAHCbnxo3LPVYdTsymeeUngUO_4";
      const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
      
      try {
        const res = await fetch(exportUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          }
        });
        
        if (!res.ok) {
          return c.json({ error: `Google sheet responded with status ${res.status}`, status: res.status }, 400);
        }
        
        const csvText = await res.text();
        const parsed = Papa.parse(csvText, {
          header: false,
          skipEmptyLines: false
        });
        
        return c.json({
          gid,
          rowCount: parsed.data.length,
          data: parsed.data
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
