# PocketJS (pocket-stack/pocketjs)

## 프로젝트 개요
스마트폰, 태블릿, PC 어디서든 별도의 복잡한 설치 없이 브라우저 안에서 즉시 앱을 실행하는 "주머니 속 이동식 휴대용 앱 구동기"
무거운 운영체제에 얽매이지 않고 가볍고 독립적인 나만의 미니 애플리케이션을 어디서나 휴대하며 실행
데이터와 앱을 내 주머니 속에 쏙 넣고 다니며 자유롭게 활용하고 싶은 디지털 노마드를 위한 신개념 런타임

## 핵심 특징 & 추천 분야
- 휴대용앱구동기
- 주머니속런타임
- 무설정즉시실행
- 디지털노마드도구
- 초경량독립플랫폼

---
*이 문서는 오픈소스 큐레이터(Curator-Agent)에 의해 자동 생성된 가이드 문서입니다.*


---
## 기존 CLAUDE.md 내용

# Repository Instructions

- If the user asks to merge the change, merge it after the relevant checks pass.
- Name pull requests (and the branch's primary commit) using the Conventional Commits format — `type(scope): summary`, e.g. `feat(gallery): …`, `fix: …`, `docs: …`, `refactor: …`.
- Keep per-run validation screenshots, videos, raw logs, traces, benchmark dumps, and build/install receipts in ignored `.pocket-build/validation/<task>/<run>/` output or an artifact store. Device validation does not require committing these files to Git.
- Put reproducible commands, results, build identities, and acceptance limits in the PR description. Attach a small selection of relevant images to the PR; do not add a new source directory for each validation run.
- Commit an image or recording when a test consumes it as a maintained fixture, or when it is an intentional product/documentation asset with an identified consumer. Temporary debugging output and historical screenshots are not test fixtures merely because they are called evidence.
- Before staging, inspect the file list and remove unintended validation artifacts. Preserve needed originals outside Git, and remove stale documentation links when cleaning up generated records. Do not infer a requirement to commit artifacts from a previous session's actions or a memory summary; apply the user's current instructions and these repository rules.
- Keep PocketJS examples explicit about API ownership: import PocketJS runtime, host components, lifecycle, input, and animation APIs from `@pocketjs/framework/*`; import Solid primitives and control flow directly from `solid-js`.
- Documentation prose (`site/content/docs/`, `docs/`) states the mechanism directly and bolds concrete engineering facts, never slogans. No meta-framing of the concept system ("ontology", "philosophy", "N nouns and one relation"), no imported architecture jargon ("vertical slice", "algebra" for an API, "first-class citizen"), no personification or dramatic one-liners, no empty intensifiers ("simply", "elegant", "magic"). No adverbs modifying a verb or adjective ("simply", "just", "actually", "typically", "carefully", "silently", "properly") — delete the adverb, or replace it with the fact it was standing in for; prepositional phrases that carry a mechanism ("once per frame", "at the down edge") are facts, not adverbs, and stay. Register reference: `site/content/docs/architecture.md` and `site/content/docs/native-contract.md`. The blog keeps its own separate voice (first-person essays); this rule is for reference documentation.
