# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]: "[plugin:runtime-error-plugin] Cannot read properties of undefined (reading 'includes')"
  - generic [ref=e5]: /home/runner/workspace/artifacts/csd-rmm-crm/src/pages/staff-contact-editor.tsx:95:47
  - generic [ref=e6]: "93 | className=\"flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60\" 94 | > 95 | {!profile.data.verifiedEmails.includes(draft.expectedEmail ?? \"\") && ( | ^ 96 | <option value={draft.expectedEmail ?? \"\"}>{draft.expectedEmail || \"No email listed\"}</option> 97 | )}"
  - generic [ref=e7]: at StaffContactEditor /home/runner/workspace/artifacts/csd-rmm-crm/src/pages/staff-contact-editor.tsx:95:47
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