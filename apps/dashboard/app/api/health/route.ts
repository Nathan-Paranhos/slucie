import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/auth";
import { database, hasDatabase } from "@/lib/db";

export async function GET() {
  const databaseConfigured = hasDatabase();
  let databaseReady = false;
  if (databaseConfigured) {
    try {
      await database().query("SELECT 1");
      databaseReady = true;
    } catch {
      databaseReady = false;
    }
  }
  const ready = databaseReady || (!databaseConfigured && isDemoMode());

  return NextResponse.json({
    status: ready ? "ok" : "not_ready",
    service: "sluice-dashboard",
    databaseConfigured,
    databaseReady,
    timestamp: new Date().toISOString()
  }, { status: ready ? 200 : 503 });
}
