# Changelog

## 0.1.0 (2026-11-14)

First release.

- Table functions over the Slack Web API: `auth_info()`, `channels()`, `users()`,
  `messages()`, `replies()`, `post_message()` and the table in-out `post_messages()`.
- Composed example queries: channels joined to their creators, a thread joined to
  author names, and `messages()` feeding `post_messages()` to nudge unanswered messages.
- Signed standalone binaries per platform (linux x86-64/arm64, macOS arm64, Windows x86-64).

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
