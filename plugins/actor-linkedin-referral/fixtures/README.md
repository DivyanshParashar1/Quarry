# actor-linkedin-referral fixtures

**Synthetic** LinkedIn profile/modal pages for the scripted fake browser:
profile with a primary Connect button, a profile where Connect hides under
"More", the "Add a note" and note modals, the Pending/1st-degree states, the
weekly-limit notice and a security checkpoint (the "999" page is covered by the
SDK's `assertNotBlocked` tests). Update with real `page.content()` captures on
the first headed run if selectors drift (all selectors live in `SEL`).
