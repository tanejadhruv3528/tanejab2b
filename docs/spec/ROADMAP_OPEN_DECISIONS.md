# Roadmap and Open Decisions

## Indicative 8–12 week pilot plan (estimate, integration-dependent)
Week 0: repo audit, Marg/vendor inquiry, payment provider inquiry, catalogue source and compliance review.
Weeks 1–2: foundation, environments, auth/RBAC, audit.
Weeks 2–3: retailer onboarding/KYC and store verification.
Weeks 3–4: catalogue import/search and inventory sync proof.
Weeks 4–6: cart, configurable pricing, COD rules, order lifecycle.
Weeks 6–7: warehouse tasks and procurement/special orders.
Weeks 7–8: payment sandbox, delivery interface and COD reconciliation.
Weeks 8–9: returns, notifications, reports.
Weeks 9–10: UAT, staff training, exception rehearsals and security checks.
Weeks 11–12: controlled pilot with 20–30 existing retailers, keeping phone orders as fallback.
Expand only when accuracy, fill rate, delivery reliability and repeat use meet owner-approved targets.

## Pilot metrics
Activated/weekly active retailers, orders per retailer, app vs phone order share, search-to-cart conversion, checkout completion, fill rate, picking accuracy, on-time delivery, cancellations/returns, payment failures, COD variance, repeat order rate.

## Decisions required
1. Final brand/name and domain.
2. Confirm discount schedule: questionnaire's 3/5/7% vs previously discussed 23/25/27%.
3. Confirm discount base, thresholds, tax and scheme stacking.
4. COD behavior at exactly ₹10,000 and whether threshold includes delivery/tax.
5. Choose a payment provider for Taneja (separate from Sanatan Sansaar's GoKwik); confirm B2B merchant fit, APIs and fees.
6. Marg integration/export options and source-of-truth boundaries.
7. Authorized medicine catalogue source and product images.
8. Confirm SKU count from Marg export.
9. Mixed cart: split special orders or separate request.
10. Return/GR eligibility and policy.
11. Cancellation window and order states allowed.
12. Cold-chain delivery controls before enabling those products.
13. Tax/invoice workflow with Marg.
14. Service zones and delivery capacity.
15. Store licence verification/re-verification process.
16. App implementation choice after repo audit.
17. Legal/regulatory sign-off before launch.

Do not treat the 2-working-day special-order target or “fastest/every medicine” as guaranteed claims.
