/**
 * Regression tests for the Phase 1 parser fixes (V2).
 *
 * Each case below corresponds to a defect found by running the parser over
 * the 13 reference AWS bills. The dollar figures in the comments are the
 * measured impact across that set, so a regression is obvious in review.
 */
import { describe, it, expect } from "vitest";
import { classifyService, normalizeUom, isPlausibleUom, tokenizeLine, hasItemizedCharges, detectBillCurrency, isRegionName } from "./billParser";

describe("D2 — EBS is Storage, not Compute", () => {
  it("files EBS under Storage even though it is invoiced beneath the EC2 header", () => {
    // $14,094.59 across the 13 reference bills was landing in Compute.
    expect(classifyService("Elastic Compute Cloud", "EBS")).toBe("Storage");
    expect(classifyService("Elastic Compute Cloud", "Elastic Block Store")).toBe("Storage");
  });

  it("still files genuine EC2 compute under Compute", () => {
    expect(classifyService("Elastic Compute Cloud", "NatGateway")).toBe("Networking & Content Delivery");
    expect(classifyService("Elastic Compute Cloud", "")).toBe("Compute");
  });

  it("does not mistake an embedded EBS substring for the storage product", () => {
    // "PaidMalwareProtectionEBSDataScanned" has no word boundary before EBS
    expect(classifyService("GuardDuty", "APS3-PaidMalwareProtectionEBSDataScanned"))
      .toBe("Security, Identity & Compliance");
  });
});

describe("D2b — the Support rule no longer swallows Marketplace software", () => {
  it("classifies third-party software with 'support' in its name as Marketplace", () => {
    // $507.04 of Ubuntu licensing was filed as AWS Support.
    expect(classifyService("Ubuntu 18 | support by Gigabits", "", "AWS Marketplace hourly software usage"))
      .toBe("AWS Marketplace");
  });

  it("still recognises genuine AWS Support charges", () => {
    expect(classifyService("AWS Support (Business)", "")).toBe("Support");
    expect(classifyService("Support", "")).toBe("Support");
  });
});

describe("Marketplace is a fallback, never an override", () => {
  it("keeps Bedrock foundation models in Machine Learning & AI", () => {
    // These bill through Marketplace but must map to the target cloud's AI
    // service in a comparative, not to "third-party software".
    expect(classifyService("Claude Sonnet 4.6 (Amazon Bedrock Edition)", "", "AWS Marketplace usage"))
      .toBe("Machine Learning & AI");
  });
});

describe("D3 — previously unclassified services now resolve deterministically", () => {
  it.each([
    ["Elastic Disaster Recovery", "Migration & Transfer"],
    ["Amplify", "Developer Tools"],
    ["Detective", "Security, Identity & Compliance"],
    ["Kiro", "Developer Tools"],
    ["Cost Explorer", "Management & Governance"],
  ])("%s -> %s", (svc, expected) => {
    expect(classifyService(svc, "")).toBe(expected);
  });
});

describe("D5 — an unrecognised unit silently dropped a real charge", () => {
  it("reads a Pages quantity column as a leaf, not a group header", () => {
    // "5,188 PagesUSD 7.78" was the entire $7.79 shortfall on bill 900206238693.
    const tok = tokenizeLine("5,188 PagesUSD 7.78");
    expect(tok).not.toBeNull();
    expect(tok!.isGroupLine).toBe(false);
    expect(tok!.quantity).toBe(5188);
    expect(tok!.costUsd).toBe(7.78);
  });

  it("recognises the units added alongside it", () => {
    ["Pages", "Documents", "Jobs", "Tasks", "Hosts", "Clusters", "Nodes"]
      .forEach(u => expect(isPlausibleUom(u)).toBe(true));
  });
});

describe("D4 — UOM normalisation", () => {
  it.each([
    ["per Secret5 Secrets", "Secrets"],
    ["Annotation Requests6 Requests", "Requests"],
    ["address720 Hrs", "Hrs"],
    ["APS3- Config urationItemRecorded", "ConfigurationItemRecorded"],
    ["Notific ations", "Notifications"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeUom(raw)).toBe(expected);
  });

  it("leaves already-clean compound units untouched", () => {
    ["GB-Mo", "Hrs", "vCPU-Hours", "ReadCapacityUnit-Hrs", "Security Checks", "GB"]
      .forEach(u => expect(normalizeUom(u)).toBe(u));
  });

  it("does not truncate GB-Mo via the region-prefix rule", () => {
    expect(normalizeUom("GB-Mo")).toBe("GB-Mo");
  });
});

describe("D1 — summary-only exports are distinguishable", () => {
  it("detects a PDF that has no itemised charges table", () => {
    expect(hasItemizedCharges("AWS estimated bill summary\nEstimated grand total:USD 871.66")).toBe(false);
  });
  it("detects a full bill export", () => {
    expect(hasItemizedCharges("Charges by service\nDescriptionUsage QuantityAmount in USD")).toBe(true);
  });
});

describe("detectBillCurrency", () => {
  // Every amount pattern in this parser requires the literal "USD", so a bill
  // in another currency parses to zero line items. Found live: a normalised INR
  // bill extracted cleanly, produced 0 items, and the customer was told to
  // contact support instead of being told the bill was not in USD.
  it("reads the currency off the charges-table header", () => {
    expect(detectBillCurrency("DescriptionUsage QuantityAmount in INR")).toBe("INR");
    expect(detectBillCurrency("DescriptionUsage QuantityAmount in USD")).toBe("USD");
  });

  it("falls back to the summary total, then the pre-tax line, then the grand total", () => {
    expect(detectBillCurrency("Total in EUR\nsomething else")).toBe("EUR");
    expect(detectBillCurrency("Amazon Web Services (4)Total pre-taxGBP 1,234.00")).toBe("GBP");
    expect(detectBillCurrency("Estimated grand total: JPY 15000")).toBe("JPY");
  });

  it("recognises a bare currency symbol on a rate line when no ISO code appears", () => {
    expect(detectBillCurrency("Rs. 20.75 per On Demand Linux m6i.large Instance Hour")).toBe("INR");
    expect(detectBillCurrency("€0,6173 per On Demand Linux m6i.xlarge Instance Hour")).toBe("EUR");
    expect(detectBillCurrency("£0.42 per On Demand Linux m6i.large Instance Hour")).toBe("GBP");
  });

  it("returns null rather than guessing when the bill states no currency", () => {
    expect(detectBillCurrency("hello world")).toBeNull();
    expect(detectBillCurrency("")).toBeNull();
  });

  it("does not mistake an unrelated three-letter word for a currency", () => {
    // "Amount in" / "Total in" are the anchors; arbitrary capitals must not match.
    expect(detectBillCurrency("EC2 NAT VPC RDS EBS")).toBeNull();
  });

  it("reads USD from a real reference bill header, so the USD path is unchanged", () => {
    expect(detectBillCurrency(
      "Amazon Web Services India Private Limited (12)Total pre-taxUSD 96.58"
    )).toBe("USD");
  });
});

describe("regions AWS launches after this code was written", () => {
  // "Mexico (Central)" launched in January 2025 and was absent from the
  // whitelist, so its line was not recognised as a region header at all:
  // currentRegion never advanced and every Mexican charge was silently
  // attributed to whichever region preceded it, or to "Global" if it came
  // first. The region x category grid is the direct input for per-region
  // price comparison, so a charge under the wrong region is worse than one
  // under no region.
  it("recognises a region that is not in the whitelist", () => {
    for (const r of ["Mexico (Central)", "Asia Pacific (Taipei)", "Asia Pacific (Kuala Lumpur)",
                     "Europe (Berlin)", "Middle East (Tel Aviv)", "China (Ningxia)"]) {
      expect(isRegionName(r)).toBe(true);
    }
  });

  it("still recognises every region it always did", () => {
    for (const r of ["US East (N. Virginia)", "EU (Ireland)", "South America (São Paulo)",
                     "AWS GovCloud (US-East)", "Global", "Any", "No Region"]) {
      expect(isRegionName(r)).toBe(true);
    }
  });

  it("never mistakes a parenthesised service qualifier for a region", () => {
    // The geographic prefix is required for exactly this reason. Verified
    // against all 10,122 distinct lines of the 13 reference bills: zero lines
    // newly match, so no reference bill can parse differently.
    for (const s of [
      "Amazon Relational Database Service for MySQL Community Edition (Multi-AZ)",
      "Amazon Elastic Compute Cloud running Linux/UNIX",
      "$0.0090 per 10,000 Proxy HTTP Requests (India)",
      "Amazon CloudFront IN-Requests-HTTP-Proxy",
      "Some Vendor Product (Ubuntu 18)",
      "Elastic Compute Cloud",
    ]) {
      expect(isRegionName(s)).toBe(false);
    }
  });
});
