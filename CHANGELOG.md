# Changelog

## 0.1.2 (2026-11-14)

- Docs link to upstream sources: the catalog docs now link the Slack Web API and its method
  reference, the Slack apps page for creating a bot token, token types and OAuth scopes
  (vgi-lint VGI183).
- The `main` schema comment is now a one-line summary; its Markdown docs no longer repeat it
  (vgi-lint VGI102).

## 0.1.1 (2026-11-14)

- The catalog comment is now one plain-text sentence describing the worker instead of the
  Markdown docs page. The full docs stay in the catalog's `vgi.doc_md` and `vgi.doc_llm` tags.

## 0.1.0 (2026-11-14)

First release.

- Table functions over the Slack Web API: `auth_info()`, `channels()`, `users()`,
  `messages()`, `replies()`, `post_message()` and the table in-out `post_messages()`.
- Composed example queries: channels joined to their creators, a thread joined to
  author names, and `messages()` feeding `post_messages()` to nudge unanswered messages.
- Signed standalone binaries per platform (linux x86-64/arm64, macOS arm64, Windows x86-64).

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
