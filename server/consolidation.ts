/**
 * Compute Savings Plan consolidation logic.
 * Detects and merges line pairs: On-Demand + Covered by Compute Savings Plans
 * into single consolidated line items with blended rates.
 */

import type { BomLineItem } from "./billParser";

export interface ConsolidatedItem extends BomLineItem {
  /** true if this item was created by consolidating a savings plan pair */
  isConsolidated?: boolean;
  /** Original cost before consolidation (for reference) */
  originalCostUsd?: number;
}

/**
 * Detect if a line item is a Compute Savings Plan credit line.
 * Typically appears as negative cost with "Compute Savings Plan" or "Savings Plans" in description.
 */
function isSavingsPlanCredit(item: BomLineItem): boolean {
  const desc = item.description.toLowerCase();
  const isSavingsPlan = desc.includes("savings plan") || desc.includes("savings plans");
  const isNegative = item.costUsd < 0;
  return isSavingsPlan && isNegative;
}

/**
 * Detect if a line item is On-Demand compute (EC2, RDS, etc.).
 */
function isOnDemandCompute(item: BomLineItem): boolean {
  const category = item.serviceCategory.toLowerCase();
  const desc = item.description.toLowerCase();
  
  // Check for compute/database services
  const isComputeService = 
    category.includes("compute") || 
    category.includes("database") ||
    desc.includes("on-demand") ||
    desc.includes("on demand");
  
  return isComputeService && item.costUsd > 0;
}

/**
 * Extract instance type/size from description.
 * E.g., "t3.medium", "r5.large", "db.t3.micro"
 */
function extractInstanceType(description: string): string | null {
  const match = description.match(/\b(db\.)?(t\d|m\d|r\d|c\d|i\d|x\d|z\d|h\d|f\d|g\d|p\d|d\d)[\w\d]*\b/i);
  return match ? match[0] : null;
}

/**
 * Create a key to match On-Demand and Savings Plan pairs.
 * Key = region + service + instance type (if applicable)
 */
function createMatchKey(item: BomLineItem): string {
  const instanceType = extractInstanceType(item.description) || "";
  return `${item.region}|${item.serviceName}|${instanceType}`.toLowerCase();
}

/**
 * Consolidate Compute Savings Plan line pairs.
 * Returns a new array where matched pairs are merged into single consolidated items.
 */
export function consolidateSavingsPlans(items: BomLineItem[]): ConsolidatedItem[] {
  const consolidated: ConsolidatedItem[] = [];
  const processedIndices = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    if (processedIndices.has(i)) continue;

    const item = items[i];
    
    // If this is a savings plan credit, look for matching on-demand line
    if (isSavingsPlanCredit(item)) {
      const matchKey = createMatchKey(item);
      
      // Find matching on-demand line
      let matchedIndex = -1;
      for (let j = 0; j < items.length; j++) {
        if (i === j || processedIndices.has(j)) continue;
        if (isOnDemandCompute(items[j])) {
          if (createMatchKey(items[j]) === matchKey) {
            matchedIndex = j;
            break;
          }
        }
      }

      if (matchedIndex !== -1) {
        // Merge the pair
        const onDemand = items[matchedIndex];
        const credit = item;

        // Consolidate quantities (both should be same, but add for safety)
        const consolidatedQty = 
          (onDemand.quantity ?? 0) + (credit.quantity ?? 0);

        // Consolidate costs (on-demand + credit = blended cost)
        const consolidatedCost = onDemand.costUsd + credit.costUsd;

        // Calculate blended rate
        const blendedRate = consolidatedQty > 0 
          ? consolidatedCost / consolidatedQty 
          : consolidatedCost;

        const consolidated_item: ConsolidatedItem = {
          region: onDemand.region,
          serviceCategory: onDemand.serviceCategory,
          serviceName: onDemand.serviceName,
          description: `${onDemand.description} (Blended with Savings Plan)`,
          quantity: consolidatedQty > 0 ? consolidatedQty : onDemand.quantity,
          uom: onDemand.uom,
          costUsd: consolidatedCost,
          needsEnrichment: onDemand.needsEnrichment || credit.needsEnrichment,
          isConsolidated: true,
          originalCostUsd: onDemand.costUsd,
        };

        consolidated.push(consolidated_item);
        processedIndices.add(i);
        processedIndices.add(matchedIndex);
        continue;
      }
    }

    // If not part of a consolidation pair, add as-is
    if (!isSavingsPlanCredit(item)) {
      consolidated.push(item);
      processedIndices.add(i);
    }
  }

  return consolidated;
}
