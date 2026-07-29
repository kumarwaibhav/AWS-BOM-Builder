/**
 * Integration tests for bills.getInsights.
 *
 * Two things must hold and neither is provable by unit-testing the domain
 * layer alone:
 *   1. the procedure returns EXACTLY what computeInsights would return for
 *      the same rows, so the API can never quietly diverge from the maths
 *      that was validated against the real bills;
 *   2. a bill belonging to another session is indistinguishable from one
 *      that does not exist.
 *
 * The database is mocked so these run without a live Postgres, and the
 * numeric coercion (Postgres returns numeric columns as strings) is
 * exercised deliberately - a silent string/number mix would corrupt every
 * total downstream.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { computeInsights } from "../insights";
import type { InsightLineItem } from "../insights";

const OWNER = "session-owner";
const OTHER = "session-someone-else";

/** Rows shaped as the driver returns them: numerics arrive as strings. */
const dbRows = [
  { region: "Asia Pacific (Mumbai)", serviceCategory: "Compute", serviceName: "Elastic Compute Cloud",
    description: "$0.2222 per On Demand Linux m6a.2xlarge Instance Hour",
    quantity: "3600.000000", uom: "Hrs", costUsd: "799.92" },
  { region: "Asia Pacific (Mumbai)", serviceCategory: "Compute", serviceName: "Elastic Compute Cloud",
    description: "m6a.2xlarge Linux instance usage covered by Compute Savings Plans",
    quantity: "3600.000000", uom: "Hrs", costUsd: "-799.92" },
  { region: "Asia Pacific (Mumbai)", serviceCategory: "Storage", serviceName: "Elastic Compute Cloud",
    description: "EBS - $0.05 per GB-Month of snapshot data stored",
    quantity: "1106.695000", uom: "GB-Mo", costUsd: "55.33" },
  { region: "US East (N. Virginia)", serviceCategory: "Networking & Content Delivery",
    serviceName: "Elastic Compute Cloud", description: "$0.056 per NAT gateway Hour",
    quantity: "720.000000", uom: "Hrs", costUsd: "40.32" },
];

const bill = {
  id: 42, sessionId: OWNER, fileName: "acme-june.pdf",
  billingPeriod: "Jun 1 - Jun 30, 2026", accountId: "123456789012",
  grandTotalUsd: "95.65",
};

const getBillById = vi.fn();
const getBomItemsByBill = vi.fn();
vi.mock("../db", () => ({
  getBillById: (...a: unknown[]) => getBillById(...a),
  getBomItemsByBill: (...a: unknown[]) => getBomItemsByBill(...a),
  getDb: vi.fn(),
  createBill: vi.fn(),
  updateBill: vi.fn(),
  listBillsBySession: vi.fn(),
  hasBillsForSession: vi.fn(),
  insertBomItems: vi.fn(),
  deleteBill: vi.fn(),
}));

/**
 * Calls the REAL wired procedure through the app router. An earlier version
 * of this file re-implemented the procedure body locally, which would have
 * kept passing even if the router drifted away from it - the exact failure
 * an integration test exists to catch.
 */
async function callGetInsights(billId: number, sessionId: string) {
  const { appRouter } = await import("../routers");
  const caller = appRouter.createCaller({ req: {} as never, res: {} as never, sessionId });
  return caller.bills.getInsights({ billId });
}

beforeEach(() => {
  getBillById.mockReset();
  getBomItemsByBill.mockReset();
  getBillById.mockResolvedValue(bill);
  getBomItemsByBill.mockResolvedValue(dbRows);
});

describe("bills.getInsights - ownership", () => {
  it("refuses a bill belonging to another session", async () => {
    await expect(callGetInsights(42, OTHER)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("gives the same answer for someone else's bill as for a missing one", async () => {
    const notMine = await callGetInsights(42, OTHER).catch(e => e.message);
    getBillById.mockResolvedValue(null);
    const missing = await callGetInsights(999, OWNER).catch(e => e.message);
    // Identical message: an attacker learns nothing about which bills exist.
    expect(notMine).toBe(missing);
  });

  it("never reads line items for a bill it rejected", async () => {
    await callGetInsights(42, OTHER).catch(() => {});
    expect(getBomItemsByBill).not.toHaveBeenCalled();
  });
});

describe("bills.getInsights - fidelity to the domain layer", () => {
  it("returns exactly what computeInsights produces for the same rows", async () => {
    const res = await callGetInsights(42, OWNER);
    const expected = computeInsights(dbRows.map(r => ({
      region: r.region, serviceCategory: r.serviceCategory, serviceName: r.serviceName,
      description: r.description, quantity: Number(r.quantity), uom: r.uom, costUsd: Number(r.costUsd),
    })));
    expect(res.insights).toEqual(expected);
  });

  it("coerces Postgres numeric strings to numbers", async () => {
    const res = await callGetInsights(42, OWNER);
    expect(typeof res.insights.totalUsd).toBe("number");
    expect(typeof res.statedTotalUsd).toBe("number");
    res.insights.byCategory.forEach(r => expect(typeof r.costUsd).toBe("number"));
    // String concatenation instead of addition would give "0799.92-799.92..."
    expect(res.insights.totalUsd).toBeCloseTo(95.65, 2);
  });

  it("carries the invoice's own printed total for the reconciliation banner", async () => {
    const res = await callGetInsights(42, OWNER);
    expect(res.statedTotalUsd).toBe(95.65);
    expect(res.billingPeriod).toBe("Jun 1 - Jun 30, 2026");
    expect(res.accountId).toBe("123456789012");
  });

  it("measures commitment against gross on-demand, through the API path", async () => {
    const res = await callGetInsights(42, OWNER);
    expect(res.insights.commitment.grossOnDemandUsd).toBeCloseTo(799.92, 2);
    expect(res.insights.commitment.savingsPlanCreditsUsd).toBeCloseTo(799.92, 2);
    expect(res.insights.commitment.coverageOfOnDemand).toBeCloseTo(1, 4);
  });
});

describe("bills.getInsights - degradation", () => {
  it("handles a bill with no line items without throwing", async () => {
    getBomItemsByBill.mockResolvedValue([]);
    const res = await callGetInsights(42, OWNER);
    expect(res.insights.totalUsd).toBe(0);
    expect(res.insights.byCategory).toEqual([]);
    expect(res.insights.notes.length).toBeGreaterThan(0);
  });

  it("handles null quantity and null uom", async () => {
    getBomItemsByBill.mockResolvedValue([
      { region: "Global", serviceCategory: "Support", serviceName: "AWS Support",
        description: "AWS Support (Business)", quantity: null, uom: null, costUsd: "100.00" },
    ]);
    const res = await callGetInsights(42, OWNER);
    expect(res.insights.totalUsd).toBe(100);
    expect(res.insights.machineRates).toEqual([]);
  });

  it("handles a null stated total", async () => {
    getBillById.mockResolvedValue({ ...bill, grandTotalUsd: null });
    const res = await callGetInsights(42, OWNER);
    expect(res.statedTotalUsd).toBeNull();
  });

  it("explains an all-on-demand bill in plain language", async () => {
    getBomItemsByBill.mockResolvedValue([dbRows[0], dbRows[3]]);
    const res = await callGetInsights(42, OWNER);
    expect(res.insights.commitment.hasNoCommitment).toBe(true);
    const msg = res.insights.notes.find(n => n.topic === "commitment")!.message;
    expect(msg).toMatch(/On-Demand/);
    expect(msg).not.toMatch(/undefined|NaN|\[object/);
  });
});

describe("bills.getInsights - performance", () => {
  it("aggregates a 1,200-row bill well inside a request budget", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({
      ...dbRows[i % dbRows.length],
      costUsd: (i % 97).toFixed(2),
    }));
    getBomItemsByBill.mockResolvedValue(many);
    const t0 = performance.now();
    const res = await callGetInsights(42, OWNER);
    const ms = performance.now() - t0;
    expect(res.insights.lineCount).toBe(1200);
    expect(ms).toBeLessThan(250);
  });
});
