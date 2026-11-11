---
name: Browser-suite command budgets
description: Avoid confusing the shell deadline with Playwright's test execution limits.
---

Run the complete frontend browser suite in a bounded background command when its total runtime may exceed the synchronous shell tool's five-minute ceiling. Keep the existing Playwright test timeouts and soak cycle count unchanged.

**Why:** A synchronous full-suite command was terminated after five minutes while the long-session soak was still running, leaving later checks unexecuted. That interruption is not evidence that Playwright exceeded its own execution budget.

**How to apply:** Run only affected checks during fixes, then obtain one complete suite result with elapsed time. Distinguish pre-existing failures from affected checks, and report any actual Playwright timeout rather than treating a terminated outer command as a completed suite.
