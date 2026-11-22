# Cold-Path Static Analysis & Runtime Join Pipeline

## Overview
Static code edges fill the cold-path gap that distributed traces miss (dormant paths, disaster recovery handlers, rare edge-case branches).
Java and Python services are parsed with Tree-sitter on merge, cached by commit SHA, and merged with OpenTelemetry (OTel) runtime edges at PR evaluation time.

---

## Pipeline Stages

### A. On Merge to Main (Per Commit SHA)
1. **Trigger:** Push / merge event to `main` or `master`.
2. **Catalog Mapping:** Map repository paths to service definitions, Protobuf / gRPC schemas, and service owners.
3. **Tree-sitter AST Extraction:**
   - **Java (Spring Boot / gRPC):** Imports, `@GrpcService`, client stubs, Spring controllers.
   - **Python (FastAPI / gRPC):** Imports, `add_*_to_server`, client stubs, route decorators.
4. **Static Snapshot Generation:**
   - Cache immutable symbol, route, and edge inventory keyed by commit SHA.
   - Includes files, owner tags, and static dependency edges.

---

### B. Tiered Import Resolution (Most Precise First)
Static imports are resolved to target services using a 3-tier hierarchy:
1. **Generated Client / Protobuf Stubs (Highest Precision):**
   - Java: `com.x.payment.grpc.*`
   - Python: `payment_pb2_grpc`
   - Explicit contract match; confidence = 1.0.
2. **Shared Package / Module Artifacts:**
   - Maven artifacts (`pom.xml`), pip packages mapped to catalog owner service.
   - Confidence = 0.8.
3. **Address / Environment Variables (Heuristic Fallback):**
   - Config targets like `PAYMENT_ADDR`, stub connection targets.
   - Confidence capped at 0.5.

---

### C. On Pull Request (PR Webhook Evaluation)
1. **Ingest Diff:** Identify modified files and symbols from git diff.
2. **Incremental Re-Parse:** Only re-parse changed files with Tree-sitter; fetch untouched files from the cached base SHA snapshot.
3. **Fetch Runtime Telemetry:** Retrieve active dependency edges from OpenTelemetry (Prometheus / Jaeger / Jaeger traces).
4. **Graph Merge:** Join static edges and runtime edges on `(caller_service, method) -> (callee_service, route)`.

---

### D. Merged Graph Conflict & Classification Rules
- **Seen in Both (Runtime + Static):**
  - Retain runtime classification (`hard` vs. `soft`).
  - Attach static call-chain proof as corroborating evidence.
- **Static Only (Cold Path / Dormant):**
  - Classified as `soft`, flagged as `unverified` ("possible caller, not observed in runtime traces").
  - Upgradable to `hard` via catalog owner policy override or chaos/fault-injection experiment confirmation.
- **Runtime Only (Dynamic / Shadow Dispatch):**
  - Classified by runtime metrics; flagged with unresolved static reason code (`dynamic_interface_dispatch`, `reflection_or_meta`, or `third_party_boundary`).

---

### E. Risk Scoring, Gating & PR Commentary
- **Scoring Rules:**
  - Static-only edge: 0 points alone (included in blast radius report, but does not trigger risk threshold).
  - Changed symbol imported by external downstream service: +1 risk score.
  - Itemized in transparent "Why" evidence table.
- **Parse Budget & Gap Disclosure:**
  - If Tree-sitter parse failure rate > 10% across modified files, return `INCOMPLETE_ANALYSIS` and explicitly disclose unparsed syntax in the PR report.
- **PR Output:**
  - Single consolidated advisory PR comment.
  - Clear `LOW` / `MEDIUM` / `HIGH` verdict with evidence labels (`[Runtime Verified]`, `[Cold Path Static]`, `[Unresolved Gaps]`).

---

### Future Roadmap
- Optional SCIP (Source Code Intelligence Protocol) index generation in CI to replace Tree-sitter heuristic symbol resolution while keeping the identical edge and risk contract.
