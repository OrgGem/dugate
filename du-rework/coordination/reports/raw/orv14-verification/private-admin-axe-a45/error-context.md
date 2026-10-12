# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: orv14-cost-adjustment-journey.spec.ts >> ORV14 served Admin financial adjustment journey >> final journey is keyboard accessible and has no critical/serious axe violations at required viewports/themes
- Location: tests/browser/admin-web/orv14-cost-adjustment-journey.spec.ts:521:7

# Error details

```
Error: 1440px dark axe violations

expect(received).toEqual(expected) // deep equality

- Expected  -  1
+ Received  + 91

- Array []
+ Array [
+   Object {
+     "description": "Ensure the contrast between foreground and background colors meets WCAG 2 AA minimum contrast ratio thresholds",
+     "help": "Elements must meet minimum color contrast ratio thresholds",
+     "helpUrl": "https://dequeuniversity.com/rules/axe/4.10/color-contrast?application=playwright",
+     "id": "color-contrast",
+     "impact": "serious",
+     "nodes": Array [
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#4c8dff",
+               "contrastRatio": 3.2,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#ffffff",
+               "fontSize": "10.5pt (14px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 3.2 (foreground color: #ffffff, background color: #4c8dff, font size: 10.5pt (14px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<button type=\"submit\" tabindex=\"0\" class=\"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] font-medium select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] transition-transform duration-75 bg-[var(--cf-blue)] text-[var(--on-action)] hover:bg-[var(--cf-blue-hover)] shadow-xs border border-transparent h-9 px-3.5 text-sm\">",
+                 "target": Array [
+                   ".flex-wrap.gap-2.flex:nth-child(2) > .bg-\\[var\\(--cf-blue\\)\\].text-\\[var\\(--on-action\\)\\].hover\\:bg-\\[var\\(--cf-blue-hover\\)\\]",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 3.2 (foreground color: #ffffff, background color: #4c8dff, font size: 10.5pt (14px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span>Apply filters</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".flex-wrap.gap-2.flex:nth-child(2) > .bg-\\[var\\(--cf-blue\\)\\].text-\\[var\\(--on-action\\)\\].hover\\:bg-\\[var\\(--cf-blue-hover\\)\\] > span",
+         ],
+       },
+       Object {
+         "all": Array [],
+         "any": Array [
+           Object {
+             "data": Object {
+               "bgColor": "#4c8dff",
+               "contrastRatio": 3.2,
+               "expectedContrastRatio": "4.5:1",
+               "fgColor": "#ffffff",
+               "fontSize": "10.5pt (14px)",
+               "fontWeight": "normal",
+               "messageKey": null,
+             },
+             "id": "color-contrast",
+             "impact": "serious",
+             "message": "Element has insufficient color contrast of 3.2 (foreground color: #ffffff, background color: #4c8dff, font size: 10.5pt (14px), font weight: normal). Expected contrast ratio of 4.5:1",
+             "relatedNodes": Array [
+               Object {
+                 "html": "<button type=\"submit\" tabindex=\"0\" class=\"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] font-medium select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] transition-transform duration-75 bg-[var(--cf-blue)] text-[var(--on-action)] hover:bg-[var(--cf-blue-hover)] shadow-xs border border-transparent h-9 px-3.5 text-sm\">",
+                 "target": Array [
+                   ".flex-wrap.gap-2.items-center > .bg-\\[var\\(--cf-blue\\)\\].text-\\[var\\(--on-action\\)\\].hover\\:bg-\\[var\\(--cf-blue-hover\\)\\]",
+                 ],
+               },
+             ],
+           },
+         ],
+         "failureSummary": "Fix any of the following:
+   Element has insufficient color contrast of 3.2 (foreground color: #ffffff, background color: #4c8dff, font size: 10.5pt (14px), font weight: normal). Expected contrast ratio of 4.5:1",
+         "html": "<span>Save draft revision</span>",
+         "impact": "serious",
+         "none": Array [],
+         "target": Array [
+           ".flex-wrap.gap-2.items-center > .bg-\\[var\\(--cf-blue\\)\\].text-\\[var\\(--on-action\\)\\].hover\\:bg-\\[var\\(--cf-blue-hover\\)\\] > span",
+         ],
+       },
+     ],
+     "tags": Array [
+       "cat.color",
+       "wcag2aa",
+       "wcag143",
+       "TTv5",
+       "TT13.c",
+       "EN-301-549",
+       "EN-9.1.4.3",
+       "ACT",
+     ],
+   },
+ ]
```

# Page snapshot

```yaml
- generic [ref=f2e3]:
  - link "Skip to content" [ref=f2e4] [cursor=pointer]:
    - /url: "#admin-content"
  - banner [ref=f2e5]:
    - generic [ref=f2e6]: Orchestrator Portal
    - time [ref=f2e9]: 10/12/2026, 3:43:00 AM UTC
    - generic [ref=f2e10]:
      - button "oidc:configured-provider · Profile" [ref=f2e11]
      - button "Logout" [ref=f2e14]
  - region "Platform health" [ref=f2e16]:
    - generic [ref=f2e17]: "Platform health: ok"
    - generic [ref=f2e18]: "Database: Healthy"
    - generic [ref=f2e19]: "Redis: Healthy"
    - generic [ref=f2e20]: "Queue integrity: OK"
    - generic [ref=f2e21]: "Active leases: 0"
    - generic [ref=f2e22]: "Outbox backlog: 0"
    - generic [ref=f2e23]: Sampled 3s ago
    - link "Health details" [ref=f2e24] [cursor=pointer]:
      - /url: /admin/system-operations/services
  - generic [ref=f2e25]:
    - complementary [ref=f2e26]:
      - navigation "Orchestrator Portal Navigation" [ref=f2e27]:
        - generic [ref=f2e28]:
          - generic [ref=f2e29]:
            - generic [ref=f2e30]: Active Tenant
            - generic [ref=f2e31]: ACTIVE
          - generic [ref=f2e34]:
            - combobox "Select active tenant" [ref=f2e35]:
              - option "ORV14 Synthetic Tenant" [selected]
            - generic "11111111-1111-4111-8111-111111111111" [ref=f2e36]: 11111111-1111-4111…
        - generic [ref=f2e37]:
          - paragraph [ref=f2e38]: Workspace
          - link "Overview" [ref=f2e39] [cursor=pointer]:
            - /url: /admin/overview
          - link "Operations" [ref=f2e40] [cursor=pointer]:
            - /url: /admin/operations
          - link "Trace" [ref=f2e41] [cursor=pointer]:
            - /url: /admin/trace
          - link "Usage" [ref=f2e42] [cursor=pointer]:
            - /url: /admin/usage
        - generic [ref=f2e43]:
          - paragraph [ref=f2e44]: System operations
          - link "Cockpit" [ref=f2e45] [cursor=pointer]:
            - /url: /admin/system-operations
          - link "Services" [ref=f2e46] [cursor=pointer]:
            - /url: /admin/system-operations/services
          - link "Workers & Queues" [ref=f2e47] [cursor=pointer]:
            - /url: /admin/system-operations/workers-queues
          - link "Incidents" [ref=f2e48] [cursor=pointer]:
            - /url: /admin/system-operations/incidents
          - link "Deployments" [ref=f2e49] [cursor=pointer]:
            - /url: /admin/system-operations/deployments
          - link "Maintenance" [ref=f2e50] [cursor=pointer]:
            - /url: /admin/system-operations/maintenance
        - generic [ref=f2e51]:
          - paragraph [ref=f2e52]: Configuration
          - link "Businesses" [ref=f2e53] [cursor=pointer]:
            - /url: /admin/businesses
          - link "Profiles" [ref=f2e54] [cursor=pointer]:
            - /url: /admin/profiles
          - link "Connectors" [ref=f2e55] [cursor=pointer]:
            - /url: /admin/connectors
          - link "Workflows" [ref=f2e56] [cursor=pointer]:
            - /url: /admin/workflows
        - generic [ref=f2e57]:
          - paragraph [ref=f2e58]: Administration
          - link "API Keys" [ref=f2e59] [cursor=pointer]:
            - /url: /admin/api-keys
          - link "Audit" [ref=f2e60] [cursor=pointer]:
            - /url: /admin/audit
          - link "Security" [ref=f2e61] [cursor=pointer]:
            - /url: /admin/security
          - link "Secrets" [ref=f2e62] [cursor=pointer]:
            - /url: /admin/secrets
          - link "Identity" [ref=f2e63] [cursor=pointer]:
            - /url: /admin/identity
          - link "Settings" [ref=f2e64] [cursor=pointer]:
            - /url: /admin/settings
        - generic [ref=f2e65]:
          - paragraph [ref=f2e66]: Resources
          - link "API Reference" [ref=f2e67] [cursor=pointer]:
            - /url: /admin/api-docs
          - link "Documentation" [ref=f2e68] [cursor=pointer]:
            - /url: /admin/docs
          - link "Bootstrap" [ref=f2e69] [cursor=pointer]:
            - /url: /admin
    - main [ref=f2e70]:
      - region [ref=f2e71]:
        - generic [ref=f2e72]:
          - heading "Usage & Cost" [level=1] [ref=f2e73]
          - generic [ref=f2e74]: tenant scoped
        - generic [ref=f2e76]:
          - generic [ref=f2e77]:
            - heading "Scope and filters" [level=3] [ref=f2e78]
            - paragraph [ref=f2e79]: Summary totals cover the full tenant window. Provider, model and operation filters apply to the event ledger below. Window bounds are UTC; the ledger window uses the persisted received time.
          - generic [ref=f2e80]:
            - generic [ref=f2e81]:
              - generic [ref=f2e82]: Active tenant
              - generic [ref=f2e83]: ORV14 Synthetic Tenant
              - code [ref=f2e84]: 11111111-1111-4111-8111-111111111111
              - generic [ref=f2e85]: ACTIVE
            - generic [ref=f2e87]:
              - generic [ref=f2e88]:
                - generic [ref=f2e89]: From (UTC)
                - textbox "From (UTC)" [ref=f2e91]: 2026-10-11T03:42
              - generic [ref=f2e92]:
                - generic [ref=f2e93]: To (UTC, exclusive)
                - textbox "To (UTC, exclusive)" [ref=f2e95]: 2026-10-12T03:42
              - generic [ref=f2e96]:
                - generic [ref=f2e97]: Provider (ledger)
                - textbox "Provider (ledger)" [ref=f2e99]:
                  - /placeholder: Any provider
              - generic [ref=f2e100]:
                - generic [ref=f2e101]: Model (ledger)
                - textbox "Model (ledger)" [ref=f2e103]:
                  - /placeholder: Any model
              - generic [ref=f2e104]:
                - generic [ref=f2e105]: Operation ID (ledger)
                - textbox "Operation ID (ledger)" [ref=f2e107]:
                  - /placeholder: Any operation
              - generic [ref=f2e108]:
                - generic [ref=f2e109]: Rows per page
                - combobox "Rows per page" [ref=f2e112]:
                  - option "25 rows"
                  - option "50 rows" [selected]
                  - option "100 rows"
              - generic [ref=f2e113]:
                - generic "Quick time windows" [ref=f2e114]:
                  - button "Last 24 hours" [ref=f2e115]
                  - button "Last 7 days" [ref=f2e117]
                  - button "Last 30 days" [ref=f2e119]
                - generic [ref=f2e121]:
                  - button "Apply filters" [ref=f2e122]
                  - button "Clear filters" [ref=f2e124]
                  - button "Refresh now" [ref=f2e126]
            - generic [ref=f2e128]:
              - 'button "Auto refresh: Off" [ref=f2e129]'
              - generic [ref=f2e131]: Refreshes the current tenant and applied filters every 10 seconds.
        - generic [ref=f2e132]:
          - generic [ref=f2e134]:
            - generic [ref=f2e135]:
              - heading "Window totals" [level=3] [ref=f2e136]
              - paragraph [ref=f2e137]: The server applies direct-root corrections and refunds before grouping current net cost; each original event’s units remain counted once. Unpriced or missing amounts are not treated as free usage.
            - generic [ref=f2e138]: "Data age: 0s"
          - generic [ref=f2e139]:
            - generic [ref=f2e140]:
              - generic [ref=f2e141]:
                - term [ref=f2e142]: Operations
                - definition [ref=f2e143]: "1"
              - generic [ref=f2e144]:
                - term [ref=f2e145]: Tokens in / out
                - definition [ref=f2e146]: 1,200 / 320
              - generic [ref=f2e147]:
                - term [ref=f2e148]: Pages
                - definition [ref=f2e149]: "1"
              - generic [ref=f2e150]:
                - term [ref=f2e151]:
                  - text: Known accrued spend
                  - generic [ref=f2e152]: Computed net cost
                - definition [ref=f2e154]: 100.000000 USD
            - paragraph [ref=f2e155]: The server projects current net cost from measured units, the frozen price snapshot, and direct-root financial adjustments. Provider-reported amounts stay separate unverified diagnostics; this is not a final invoice. Cost status can be measured, estimated, pending, unpriced, or unavailable in older rows.
            - generic [ref=f2e156]:
              - generic [ref=f2e157]:
                - heading "Provider and model breakdown" [level=2] [ref=f2e158]
                - paragraph [ref=f2e159]: Rows preserve the status reported by the summary service. Unit measurement and cost status are shown separately.
              - region "Provider and model usage table" [ref=f2e160]:
                - table "Usage by provider and model" [ref=f2e161]:
                  - rowgroup [ref=f2e162]:
                    - row [ref=f2e163]:
                      - columnheader "Provider / model" [ref=f2e164]
                      - columnheader "Operations" [ref=f2e165]
                      - columnheader "Tokens in / out" [ref=f2e166]
                      - columnheader "Pages" [ref=f2e167]
                      - columnheader "Unit measurement" [ref=f2e168]
                      - columnheader "Cost status / amount" [ref=f2e169]
                  - rowgroup [ref=f2e170]:
                    - row [ref=f2e171]:
                      - cell "openai gpt-4o" [ref=f2e172]:
                        - generic [ref=f2e173]:
                          - generic [ref=f2e174]: openai
                          - generic [ref=f2e175]: gpt-4o
                      - cell "1" [ref=f2e176]
                      - cell "1,200 / 320" [ref=f2e177]
                      - cell "1" [ref=f2e178]
                      - cell "Measured units" [ref=f2e179]
                      - cell "Computed from measured units Computed · 100.000000 USD" [ref=f2e180]:
                        - generic [ref=f2e181]:
                          - generic [ref=f2e182]: Computed from measured units
                          - generic [ref=f2e184]: Computed · 100.000000 USD
        - generic [ref=f2e185]:
          - generic [ref=f2e187]:
            - generic [ref=f2e188]:
              - heading "Usage event ledger" [level=3] [ref=f2e189]
              - paragraph [ref=f2e190]: Received-time order, oldest first. Timestamps are UTC. The event’s computed initial charge stays immutable; current gross, refunds and net come from the server’s direct-root accounting projection. A missing amount or status is unavailable, and a reported zero is not an invoice. Operation links open the tenant-scoped operation record.
            - generic [ref=f2e191]:
              - generic [ref=f2e192]: "Data age: 0s"
              - button "Export this page CSV (1)" [ref=f2e193]
          - generic [ref=f2e195]:
            - region "Usage event ledger table" [ref=f2e196]:
              - table "Usage event ledger" [ref=f2e197]:
                - rowgroup [ref=f2e198]:
                  - row [ref=f2e199]:
                    - columnheader "Event / received" [ref=f2e200]
                    - columnheader "Operation" [ref=f2e201]
                    - columnheader "Provider / model" [ref=f2e202]
                    - columnheader "Units" [ref=f2e203]
                    - columnheader "Original charge / current accounting" [ref=f2e204]
                - rowgroup [ref=f2e205]:
                  - row [ref=f2e206]:
                    - cell "orv14-finance-root-001 Received 2026-10-12 02:42:55 UTC Occurred 2026-10-12 02:42:55 UTC" [ref=f2e207]:
                      - generic [ref=f2e208]:
                        - code [ref=f2e209]: orv14-finance-root-001
                        - time [ref=f2e210]: Received 2026-10-12 02:42:55 UTC
                        - generic [ref=f2e211]: Occurred 2026-10-12 02:42:55 UTC
                    - cell "Open operation 66666666-6666-4666-8666-666666666666 in Operations Task 77777777-7777-4777-8777-777777777777 Invocation orv14-invocation-opaque-001" [ref=f2e212]:
                      - link "Open operation 66666666-6666-4666-8666-666666666666 in Operations" [ref=f2e213] [cursor=pointer]:
                        - /url: /admin/operations?id=66666666-6666-4666-8666-666666666666
                        - text: 66666666-6666-4666-8666-666666666666
                      - generic [ref=f2e214]: Task 77777777-7777-4777-8777-777777777777
                      - generic [ref=f2e215]: Invocation orv14-invocation-opaque-001
                    - cell "openai gpt-4o" [ref=f2e216]:
                      - generic [ref=f2e217]:
                        - generic [ref=f2e218]: openai
                        - generic [ref=f2e219]: gpt-4o
                    - cell "In 1,200 Out 320 Pages 1 Measured units" [ref=f2e220]:
                      - generic [ref=f2e221]: In 1,200
                      - generic [ref=f2e222]: Out 320
                      - generic [ref=f2e223]: Pages 1
                      - generic [ref=f2e224]: Measured units
                    - 'cell "Computed from measured units Immutable initial charge: Computed · 100.000000 USD Server financial accounting projection Provider-reported amount (unverified): 102.000000 USD Diagnostic difference: 2.000000 USD. Close adjustment details" [ref=f2e225]':
                      - generic [ref=f2e226]:
                        - generic [ref=f2e227]: Computed from measured units
                        - generic [ref=f2e229]: "Immutable initial charge: Computed · 100.000000 USD"
                        - generic "Server financial accounting projection" [ref=f2e230]:
                          - paragraph [ref=f2e231]: Current server accounting · revision 0
                          - generic [ref=f2e232]:
                            - generic [ref=f2e233]:
                              - term [ref=f2e234]: Gross
                              - definition [ref=f2e235]: 100.000000 USD
                            - generic [ref=f2e236]:
                              - term [ref=f2e237]: Refunded
                              - definition [ref=f2e238]: 0.000000 USD
                            - generic [ref=f2e239]:
                              - term [ref=f2e240]: Current net
                              - definition [ref=f2e241]: 100.000000 USD
                            - generic [ref=f2e242]:
                              - term [ref=f2e243]: Root event
                              - definition [ref=f2e244]: orv14-finance-root-001
                          - paragraph [ref=f2e245]: Authorized adjustments change accounting amounts only; original usage units are counted once.
                        - generic [ref=f2e246]:
                          - paragraph [ref=f2e247]: "Provider-reported amount (unverified): 102.000000 USD"
                          - paragraph [ref=f2e248]: "Diagnostic difference: 2.000000 USD."
                        - group [ref=f2e249]:
                          - generic "BASIC legacy record" [ref=f2e250] [cursor=pointer]
                        - button "Close adjustment details" [ref=f2e251]
                  - row [ref=f2e253]:
                    - cell [ref=f2e254]:
                      - region "Financial adjustment details" [ref=f2e255]:
                        - generic [ref=f2e256]:
                          - generic [ref=f2e257]:
                            - heading "Cost adjustment history" [level=3] [ref=f2e258]
                            - paragraph [ref=f2e259]: Adjustments attach directly to original event orv14-finance-root-001. The server projects current gross, refunds and net; original cost, units and event time remain unchanged. Provider-reported amounts remain unverified diagnostics.
                          - generic [ref=f2e260]:
                            - button "Export current history page CSV (0)" [disabled]
                            - button "Reload history" [ref=f2e261]
                        - generic [ref=f2e263]:
                          - heading "Original immutable attribution" [level=4] [ref=f2e264]
                          - generic [ref=f2e265]:
                            - generic [ref=f2e266]:
                              - term [ref=f2e267]: Original operation
                              - definition [ref=f2e268]: 66666666-6666-4666-8666-666666666666
                            - generic [ref=f2e269]:
                              - term [ref=f2e270]: Task / invocation / attempt
                              - definition [ref=f2e271]: 77777777-7777-4777-8777-777777777777 · orv14-invocation-opaque-001 · 1
                            - generic [ref=f2e272]:
                              - term [ref=f2e273]: Business / action
                              - definition [ref=f2e274]: document-core v1.0.0 · extract
                            - generic [ref=f2e275]:
                              - term [ref=f2e276]: Connector / price
                              - definition [ref=f2e277]: synthetic-provider r3 · price r9 · sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
                            - generic [ref=f2e278]:
                              - term [ref=f2e279]: Frozen provenance
                              - definition [ref=f2e280]: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
                            - generic [ref=f2e281]:
                              - term [ref=f2e282]: Original event time
                              - definition [ref=f2e283]: 2026-10-12 02:42:55 UTC · measured computed price
                            - generic [ref=f2e284]:
                              - term [ref=f2e285]: Original measured units
                              - definition [ref=f2e286]: Input 1,200 · cached 0 · output 320 · pages 1 · 850 ms
                            - generic [ref=f2e287]:
                              - term [ref=f2e288]: Key / Profile
                              - definition [ref=f2e289]: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa · bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb r4
                            - generic [ref=f2e290]:
                              - term [ref=f2e291]: Pinned quota windows
                              - definition [ref=f2e292]: No quota window pins
                        - generic [ref=f2e293]:
                          - generic [ref=f2e294]:
                            - paragraph [ref=f2e295]: Initial computed charge
                            - paragraph [ref=f2e296]: 100.000000 USD
                          - generic [ref=f2e297]:
                            - paragraph [ref=f2e298]: Current gross
                            - paragraph [ref=f2e299]: 100.000000 USD
                          - generic [ref=f2e300]:
                            - paragraph [ref=f2e301]: Refunded
                            - paragraph [ref=f2e302]: 0.000000 USD
                          - generic [ref=f2e303]:
                            - paragraph [ref=f2e304]: Current net
                            - paragraph [ref=f2e305]: 100.000000 USD
                        - generic [ref=f2e306]:
                          - generic [ref=f2e307]: Eligible for adjustment
                          - generic [ref=f2e309]: Adjustment head r0 · original event time is retained; each administrative decision has a separate recorded time.
                        - paragraph [ref=f2e310]: The server rechecks the current adjustment revision and evidence at confirmation. A correction replaces gross charge; a refund adds a positive credit delta. The server computes net. Original usage units, trust classification, provenance and accounting time remain unchanged.
                        - paragraph [ref=f2e311]: No correction or refund has been recorded for this original event.
                        - group "Prepare an administrative adjustment" [ref=f2e312]:
                          - paragraph [ref=f2e314]: Financial correction authority is an administrative accounting action. It does not verify a provider-reported amount or change the original usage provenance.
                          - generic [ref=f2e315]:
                            - generic [ref=f2e316]:
                              - text: Adjustment
                              - combobox "Adjustment" [ref=f2e317]:
                                - option "Correction · replace gross total" [selected]
                                - option "Refund · credit delta"
                            - generic [ref=f2e318]:
                              - text: Replacement gross charge (integer micro-USD)
                              - spinbutton "Replacement gross charge (integer micro-USD) Current gross is 100.000000 USD; current net is 100.000000 USD. Enter an exact integer amount. The server validates refund limits and computes resulting net." [active] [ref=f2e319]
                              - generic [ref=f2e320]: Current gross is 100.000000 USD; current net is 100.000000 USD. Enter an exact integer amount. The server validates refund limits and computes resulting net.
                          - generic [ref=f2e321]:
                            - text: Reason
                            - textbox "Reason" [ref=f2e322]:
                              - /placeholder: Explain the accounting correction or refund
                          - generic [ref=f2e323]:
                            - generic [ref=f2e324]:
                              - text: Search existing READY evidence for this tenant
                              - searchbox "Search existing READY evidence for this tenant" [ref=f2e325]
                            - generic [ref=f2e326]:
                              - text: Evidence artifact
                              - combobox "Evidence artifact Only server-confirmed READY, same-tenant artifacts with complete immutable storage pins appear. The service verifies the current pins again when you confirm." [ref=f2e327]:
                                - option "Choose an existing READY artifact" [selected]
                                - option "synthetic-invoice-evidence.pdf · 640 bytes · 2026-10-11 00:00:00 UTC"
                              - text: Only server-confirmed READY, same-tenant artifacts with complete immutable storage pins appear. The service verifies the current pins again when you confirm.
                            - generic [ref=f2e328]: 1 evidence item(s) loaded for this search.
                          - generic [ref=f2e330]:
                            - button "Review adjustment" [disabled]
            - generic [ref=f2e331]:
              - generic [ref=f2e332]: Page 1 · up to 50 rows · export contains this page only.
              - generic [ref=f2e333]:
                - button "Previous page" [disabled]
                - button "Next page" [disabled]
        - generic [ref=f2e334]:
          - generic [ref=f2e335]:
            - generic [ref=f2e336]:
              - heading "Budget policy" [level=3] [ref=f2e337]
              - paragraph [ref=f2e338]: Immutable tenant-scoped budget revisions. Draft changes have no effect until they pass review and publish.
            - generic [ref=f2e339]:
              - generic [ref=f2e340]:
                - generic [ref=f2e341]:
                  - generic [ref=f2e342]: Budget policy
                  - combobox "Choose a budget policy" [ref=f2e345]:
                    - option "Create a new budget" [selected]
                - generic [ref=f2e346]: "Active tenant: 11111111-1111-4111-8111-111111111111. Cost values are integer micro-USD; nothing resets existing used or held quota."
              - generic [ref=f2e347]:
                - generic [ref=f2e348]:
                  - generic [ref=f2e349]:
                    - generic [ref=f2e350]: Window
                    - combobox "Window" [ref=f2e353]:
                      - option "Daily (UTC)"
                      - option "Monthly (UTC)" [selected]
                  - generic [ref=f2e354]:
                    - generic [ref=f2e355]: Token limit
                    - textbox "Token limit" [ref=f2e357]: "100000"
                  - generic [ref=f2e358]:
                    - generic [ref=f2e359]: Spend limit (USD)
                    - textbox "Spend limit (USD)" [ref=f2e361]: "1000"
                    - paragraph [ref=f2e362]: Up to 6 decimal places; stored as integer micro-USD.
                  - generic [ref=f2e363]:
                    - generic [ref=f2e364]: Warning threshold (%)
                    - textbox "Warning threshold (%)" [ref=f2e366]: "80"
                  - generic [ref=f2e367]:
                    - generic [ref=f2e368]: Enforcement policy
                    - combobox "Enforcement policy" [ref=f2e371]:
                      - option "Alert only" [selected]
                      - option "Block new invocations"
                  - generic [ref=f2e372]:
                    - generic [ref=f2e373]: Budget status
                    - combobox "Budget status" [ref=f2e376]:
                      - option "Active" [selected]
                      - option "Suspended"
                  - generic [ref=f2e377]:
                    - generic [ref=f2e378]: API key scope
                    - generic [ref=f2e379]:
                      - textbox "Search API keys" [ref=f2e380]:
                        - /placeholder: Search by key prefix
                      - combobox "Budget API key scope" [ref=f2e382]:
                        - option "All tenant API keys" [selected]
                    - paragraph [ref=f2e383]: Any key applies the limit across all tenant keys.
                  - generic [ref=f2e384]:
                    - generic [ref=f2e385]: Profile scope
                    - generic [ref=f2e386]:
                      - textbox "Search profiles" [ref=f2e387]:
                        - /placeholder: Search profile, business, or action
                      - combobox "Budget profile scope" [ref=f2e389]:
                        - option "All profiles" [selected]
                    - paragraph [ref=f2e390]: Choices are current active profiles; choose a key first to narrow results.
                  - generic [ref=f2e391]:
                    - generic [ref=f2e392]: Business scope
                    - generic [ref=f2e393]:
                      - textbox "Search businesses" [ref=f2e394]:
                        - /placeholder: Search business
                      - combobox "Budget business scope" [ref=f2e396]:
                        - option "All tenant businesses" [selected]
                    - paragraph [ref=f2e397]: Only tenant profile or operation businesses appear; a selected profile narrows this list.
                - group "Notification channel" [ref=f2e398]:
                  - paragraph [ref=f2e400]: Choose the trusted in-app destination. A binding can only use channel IDs pinned to this exact published revision.
                  - paragraph [ref=f2e401]: No enabled alert channels are configured.
                - generic [ref=f2e402]:
                  - heading "Draft diff from current head" [level=3] [ref=f2e403]
                  - list [ref=f2e404]:
                    - listitem [ref=f2e405]: New tenant budget policy
                - paragraph [ref=f2e406]: A configured block policy fails closed before provider send if the request, price basis, earlier usage, or unresolved reservations lack a verified upper bound. The UI does not claim remaining capacity from incomplete trust. Choose Alert only explicitly if best-effort admission is intended.
                - generic [ref=f2e407]:
                  - button "Save draft revision" [ref=f2e408]
                  - generic [ref=f2e410]: New budget head at revision 0
          - generic [ref=f2e411]:
            - generic [ref=f2e412]:
              - heading "Published price book" [level=3] [ref=f2e413]
              - paragraph [ref=f2e414]: Platform Admin price revisions use structured tier rows, whole micro-USD rates, review, publish, history, retirement, and CAS rollback.
            - generic [ref=f2e415]:
              - paragraph [ref=f2e416]: Head 0 · active none
              - generic [ref=f2e417]:
                - generic [ref=f2e418]:
                  - generic [ref=f2e420]:
                    - generic [ref=f2e421]: Draft source revision
                    - combobox "Draft source revision" [ref=f2e424]
                  - paragraph [ref=f2e425]: "Diff: Invalid"
                - group "Price tier 1" [ref=f2e426]:
                  - generic [ref=f2e428]:
                    - generic [ref=f2e429]: Provider (optional)
                    - textbox "Provider (optional)" [ref=f2e431]:
                      - /placeholder: Provider slug
                  - generic [ref=f2e432]:
                    - generic [ref=f2e433]: Model
                    - textbox "Model" [ref=f2e435]:
                      - /placeholder: Model ID
                  - generic [ref=f2e436]:
                    - generic [ref=f2e437]: Price version
                    - textbox "Price version" [ref=f2e439]: "1"
                  - generic [ref=f2e440]:
                    - generic [ref=f2e441]: Effective from (UTC)
                    - textbox "Effective from (UTC)" [ref=f2e443]: 2026-10-12T03:42
                  - generic [ref=f2e444]:
                    - generic [ref=f2e445]: Effective to (UTC, optional)
                    - textbox "Effective to (UTC, optional)" [ref=f2e447]
                  - generic [ref=f2e448]:
                    - generic [ref=f2e449]: Input USD / million tokens
                    - textbox "Input USD / million tokens" [ref=f2e451]: "0"
                  - generic [ref=f2e452]:
                    - generic [ref=f2e453]: Output USD / million tokens
                    - textbox "Output USD / million tokens" [ref=f2e455]: "0"
                  - generic [ref=f2e456]:
                    - generic [ref=f2e457]: Cached input USD / million (optional)
                    - textbox "Cached input USD / million (optional)" [ref=f2e459]
                  - generic [ref=f2e460]:
                    - generic [ref=f2e461]: Page USD / page (optional)
                    - textbox "Page USD / page (optional)" [ref=f2e463]
                  - generic [ref=f2e464]:
                    - button "Remove tier" [disabled]
                - generic [ref=f2e465]:
                  - button "Add price tier" [ref=f2e466]
                  - button "Save price draft" [disabled]
                - paragraph [ref=f2e468]: Enter USD rates to 6 decimal places; storage uses exact integer micro-USD. Overlapping provider/model effective windows or duplicate price versions are rejected before submission.
              - generic [ref=f2e469]:
                - heading "Price revision actions" [level=3] [ref=f2e470]
                - generic [ref=f2e471]:
                  - generic [ref=f2e472]:
                    - generic [ref=f2e473]: Review / rollback reason
                    - textbox "Review / rollback reason" [ref=f2e475]:
                      - /placeholder: Explain the pricing change
                  - generic [ref=f2e476]:
                    - generic [ref=f2e477]: Rollback source revision
                    - combobox "Rollback source revision" [ref=f2e480]:
                      - option "Choose a revision" [selected]
                - generic [ref=f2e481]:
                  - button "Create rollback draft" [disabled]
              - table [ref=f2e483]:
                - rowgroup [ref=f2e484]:
                  - row [ref=f2e485]:
                    - columnheader "Revision" [ref=f2e486]
                    - columnheader "State" [ref=f2e487]
                    - columnheader "Tiers" [ref=f2e488]
                    - columnheader "Created" [ref=f2e489]
                    - columnheader "Digest" [ref=f2e490]
                - rowgroup
        - generic [ref=f2e491]:
          - generic [ref=f2e492]:
            - generic [ref=f2e494]:
              - generic [ref=f2e495]:
                - heading "Cost alerts" [level=3] [ref=f2e496]
                - paragraph [ref=f2e497]: Persisted threshold, limit, and trust-gap events from reservation preflight and final usage settlement.
              - button "Refresh alerts" [ref=f2e498]
            - generic [ref=f2e500]:
              - generic [ref=f2e501]:
                - generic [ref=f2e502]:
                  - text: Alert type
                  - combobox "Filter alerts by type" [ref=f2e504]:
                    - option "All alert types" [selected]
                    - option "Warning threshold"
                    - option "Budget limit"
                    - option "Trust gap"
                - paragraph [ref=f2e505]: Alert history is tenant scoped and cursor bounded. Owner and channel references stay frozen to the exact budget and binding revisions.
              - paragraph [ref=f2e506]: No alert events match this tenant and filter.
          - generic [ref=f2e507]:
            - generic [ref=f2e509]:
              - generic [ref=f2e510]:
                - heading "Owner notification inbox" [level=3] [ref=f2e511]
                - paragraph [ref=f2e512]: Durable in-app alerts delivered to the bound local or external OIDC tenant Admin owner. Only that current identity can read or acknowledge its inbox.
              - generic [ref=f2e513]:
                - button "Register this Admin for inbox" [ref=f2e514]
                - button "Refresh inbox" [ref=f2e516]
            - generic [ref=f2e518]:
              - paragraph [ref=f2e519]: Register this signed-in platform Admin once to receive owner-scoped budget notifications. This links only the in-app alert inbox; it does not change your ordinary Admin access.
              - generic [ref=f2e520]:
                - text: Show notifications
                - combobox "Filter owner inbox" [ref=f2e522]:
                  - option "Unread only" [selected]
                  - option "All notifications"
              - paragraph [ref=f2e523]: No notifications in this inbox page.
```

# Test source

```ts
  454 |     await expect(page.getByText(/held while the backup or recovery safety gate is active/)).toBeVisible();
  455 |     await expect(page.locator('[aria-label="Adjustment review"]')).toContainText('80.000000 USD');
  456 |     await expect(page.getByLabel('Replacement gross charge')).toHaveValue('80000000');
  457 |     await expect(page.getByLabel('Evidence artifact')).toHaveValue(EVIDENCE_ID);
  458 |     await expect(page.getByText(/adjustment head changed before confirmation/i)).toHaveCount(0);
  459 |     expect(fixture.writes).toHaveLength(command + 1);
  460 |     await submitReview(page);
  461 |     await expect(page.getByRole('region', { name: 'Financial adjustment details' }).getByText(/Replacement gross charge 80\.000000 USD · gross 80\.000000 USD · refunded 0\.000000 USD · net 80\.000000 USD/)).toBeVisible();
  462 |     expect(fixture.writes).toHaveLength(command + 2);
  463 |     expect(fixture.writes[0]?.command).toEqual(fixture.writes[1]?.command);
  464 |     expect(fixture.writes[0]?.idempotencyKey).not.toBe(fixture.writes[1]?.idempotencyKey);
  465 |     expect(fixture.writes[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  466 |     expect(fixture.writes[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  467 |     expect(reviewText).toContain('80.000000 USD');
  468 |     recordAssets(fixture);
  469 |   });
  470 | 
  471 |   test('typed adjustment-head CAS conflict reloads history without clearing entered values', async ({ page }) => {
  472 |     const fixture = await installFinanceApi(page);
  473 |     fixture.queuedPosts.push({ status: 409, code: 'COST_ADJUSTMENT_CAS_CONFLICT' });
  474 |     await loginAndOpenUsage(page);
  475 |     await openAdjustmentDetails(page);
  476 |     await prepareAndReview(page, 80_000_000);
  477 |     await submitReview(page);
  478 |     await expect(page.getByText(/adjustment head changed before confirmation/i)).toBeVisible();
  479 |     await expect(page.locator('[aria-label="Adjustment review"]')).toHaveCount(0);
  480 |     await expect(page.getByLabel('Replacement gross charge')).toHaveValue('80000000');
  481 |     await expect(page.getByRole('textbox', { name: 'Reason', exact: true })).toHaveValue('Correct invoice total after review');
  482 |     await expect(page.getByLabel('Evidence artifact')).toHaveValue(EVIDENCE_ID);
  483 |     await expect(page.getByText('Adjustment head r1')).toBeVisible();
  484 |     await page.getByRole('button', { name: 'Review adjustment' }).click();
  485 |     await expect(page.locator('[aria-label="Adjustment review"]')).toContainText('Revision 1');
  486 |     expect(fixture.writes).toHaveLength(1);
  487 |     recordAssets(fixture);
  488 |   });
  489 | 
  490 |   test('503 unknown acknowledgement keeps the exact command and idempotency key for recheck', async ({ page }) => {
  491 |     const fixture = await installFinanceApi(page);
  492 |     fixture.queuedPosts.push({ status: 503, code: 'UPSTREAM_UNAVAILABLE' }, { status: 201, code: 'OK' });
  493 |     await loginAndOpenUsage(page);
  494 |     await openAdjustmentDetails(page);
  495 |     await prepareAndReview(page, 80_000_000);
  496 |     await submitReview(page);
  497 |     await expect(page.getByText(/server acknowledgement is unknown/i)).toBeVisible();
  498 |     await expect(page.getByRole('button', { name: 'Recheck same adjustment request' })).toBeVisible();
  499 |     const first = fixture.writes[0];
  500 |     await page.getByRole('button', { name: 'Recheck same adjustment request' }).click();
  501 |     await expect(page.getByRole('region', { name: 'Financial adjustment details' }).getByText(/Replacement gross charge 80\.000000 USD · gross 80\.000000 USD · refunded 0\.000000 USD · net 80\.000000 USD/)).toBeVisible();
  502 |     expect(fixture.writes).toHaveLength(2);
  503 |     expect(fixture.writes[1]?.command).toEqual(first?.command);
  504 |     expect(fixture.writes[1]?.idempotencyKey).toBe(first?.idempotencyKey);
  505 |     recordAssets(fixture);
  506 |   });
  507 | 
  508 |   test('tenant USER session reads scoped history and has no adjustment controls', async ({ page }) => {
  509 |     const fixture = await installFinanceApi(page, { session: 'tenant-user' });
  510 |     await loginAndOpenUsage(page);
  511 |     await openAdjustmentDetails(page, false);
  512 |     await expect(page.getByText('Financial adjustment history is read only. A current platform Admin must review and record changes.')).toBeVisible();
  513 |     await expect(page.getByRole('button', { name: 'Review adjustment' })).toHaveCount(0);
  514 |     await expect(page.getByLabel('Replacement gross charge')).toHaveCount(0);
  515 |     expect(fixture.historyRequests.length).toBeGreaterThan(0);
  516 |     expect(fixture.historyRequests.every((request) => request.searchParams.get('tenantId') === TENANT)).toBe(true);
  517 |     expect(fixture.eventQueries.every((request) => request.searchParams.get('tenantId') === TENANT)).toBe(true);
  518 |     recordAssets(fixture);
  519 |   });
  520 | 
  521 |   test('final journey is keyboard accessible and has no critical/serious axe violations at required viewports/themes', async ({ page }) => {
  522 |     const fixture = await installFinanceApi(page);
  523 |     await loginAndOpenUsage(page);
  524 |     await openAdjustmentDetails(page);
  525 |     await expect(page.getByRole('region', { name: 'Financial adjustment details' })).toBeVisible();
  526 | 
  527 |     await page.getByRole('combobox', { name: /^Adjustment/ }).focus();
  528 |     await page.keyboard.press('Tab');
  529 |     const focus = await page.evaluate(() => {
  530 |       const active = document.activeElement as (HTMLElement & { labels?: NodeListOf<HTMLLabelElement> }) | null;
  531 |       if (!active) return null;
  532 |       const style = getComputedStyle(active);
  533 |       const labels = active.labels ? Array.from(active.labels).map((label) => label.innerText).join(' ') : '';
  534 |       return { label: active.getAttribute('aria-label') ?? (labels || active.textContent?.trim() || ''), outline: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
  535 |     });
  536 |     expect(focus).not.toBeNull();
  537 |     expect(focus!.label).toContain('Replacement gross charge');
  538 |     expect(focus!.outline !== 'none' || focus!.boxShadow !== 'none' || Number.parseFloat(focus!.outlineWidth) > 0).toBe(true);
  539 | 
  540 |     const reports: Array<{ width: number; theme: string; criticalOrSerious: string[] }> = [];
  541 |     for (const width of [1440, 768, 390, 320]) {
  542 |       await page.setViewportSize({ width, height: 900 });
  543 |       for (const theme of ['light', 'dark']) {
  544 |         await page.evaluate((mode) => {
  545 |           if (mode === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  546 |           else document.documentElement.removeAttribute('data-theme');
  547 |         }, theme);
  548 |         await expect(page.getByRole('region', { name: 'Financial adjustment details' })).toBeVisible();
  549 |         const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  550 |         expect(dimensions.scroll, `${width}px ${theme} viewport overflow`).toBeLessThanOrEqual(dimensions.client + 1);
  551 |         const axe = await new AxeBuilder({ page }).analyze();
  552 |         const material = axe.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  553 |         reports.push({ width, theme, criticalOrSerious: material.map((violation) => `${violation.impact}:${violation.id}`) });
> 554 |         expect(material, `${width}px ${theme} axe violations`).toEqual([]);
      |                                                                ^ Error: 1440px dark axe violations
  555 |         await page.screenshot({ path: join(EVIDENCE_DIR, `orv14-finance-${width}-${theme}.png`), fullPage: true });
  556 |       }
  557 |     }
  558 |     console.info(`ORV14_FINANCE_UI_MATRIX ${json(reports)}`);
  559 |     recordAssets(fixture);
  560 |   });
  561 | });
  562 | 
```