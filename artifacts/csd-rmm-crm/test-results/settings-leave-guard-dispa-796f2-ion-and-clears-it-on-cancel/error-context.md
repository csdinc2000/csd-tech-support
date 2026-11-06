# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]: "[plugin:runtime-error-plugin] Cannot read properties of undefined (reading 'activeCallRecipients')"
  - generic [ref=e5]: /home/runner/workspace/artifacts/csd-rmm-crm/src/pages/dispatch-settings.tsx:72:34
  - generic [ref=e6]: "70 | messages: pick(settings.data?.routing.activeMessageRecipients ?? []), 71 | }; 72 | }, [recipients, settings.data?.routing.activeCallRecipients, settings.data?.routing.activeMessageRecipients]); | ^ 73 | const normalizedPhone = normalizeUsPhone(draft.phone); 74 | const isPending = create.isPending || update.isPending;"
  - generic [ref=e7]: at DispatchSettingsPage /home/runner/workspace/artifacts/csd-rmm-crm/src/pages/dispatch-settings.tsx:72:34
  - generic [ref=e8]:
    - text: Click outside, press Esc key, or fix the code to dismiss.
    - text: You can also disable this overlay by setting
    - code [ref=e9]: server.hmr.overlay
    - text: to
    - code [ref=e10]: "false"
    - text: in
    - code [ref=e11]: vite.config.ts
    - text: .
```