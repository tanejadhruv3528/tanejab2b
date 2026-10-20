# Taneja Drug Agency — B2B Medicine Platform
Read `CLAUDE.md`, then `docs/spec/PRD.md`, `docs/spec/ARCHITECTURE.md`, `docs/spec/ROADMAP_OPEN_DECISIONS.md`. Start with `prompts/01_REPO_AUDIT.md`. This pack is a development baseline, not a claim that integrations or legal review are complete.

## Source-of-truth facts supplied by the owner
- Taneja Drug Agency, Samastipur, Bihar; approximately 50 years in business.
- 950 sq. ft. warehouse, 20 staff, 500+ retailer customers, stated ₹2–3 crore inventory, 3 riders, roughly 25 km delivery radius; delivery currently around 1 PM–8 PM. Owner-provided estimates.
- Marg 9.0 desktop; API/integration availability unknown.
- Current orders mainly by phone and walk-in. Fulfillment flow: challan, consolidate items, review/complete shortages, bill, hand over.
- All retailer orders must be fulfilled from Taneja's warehouse only. Other wholesalers/companies are internal procurement sources, never marketplace sellers/direct fulfillers.
- English/Hindi, simple mobile-first retailer experience; Android and iOS desired.
- No retailer credit. Prepaid or eligible COD. COD not allowed above ₹10,000; location and admin eligibility also apply.
- Proposed minimum order ₹3,000, delivery fee ₹50; configurable pending confirmation.
- Special-order target around 2 working days is an estimate, not a guarantee.
- Discount slabs conflict: questionnaire says 3% below ₹4,000, 5% under ₹10,000, 7% above ₹15,000; earlier conversation mentioned 23%/25%/27%. Do not activate discounts until owner confirms exact rules.
- Product name undecided. “Taneja B2B” is a placeholder.
- SKU count unknown; questionnaire's “more than 1,00,000” was written under product categories and is not a verified SKU count.
- Payment provider is undecided. GoKwik belongs to a separate business (Sanatan Sansaar) and must not be reused here; pick a provider for Taneja on its own merits.
- Do not scrape Tata 1mg or other consumer sites for production data without permission and legal review.
