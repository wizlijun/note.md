#pragma once
#include <stdint.h>
// All calls, including callbacks, occur on the application main thread.
// Edit callback returns the accepted revision (>=0), or -1 to reject and restore.
// Optional projection is owned by Rust and released with free_reply after parsing.
// AppKit applies it before returning from the current input event.
typedef int64_t (*SumiEventCallback)(void *context, const char *json, char **projection);
typedef void (*SumiReplyFree)(char *projection);
void *sumi_editor_mount(void *reference_view, int webview_sibling, const char *json, SumiEventCallback callback, SumiReplyFree free_reply, void *context);
int sumi_editor_command(void *editor, const char *json);
char *sumi_editor_inspect(void *editor);
void sumi_editor_free_string(char *value);
void sumi_editor_detach(void *editor);
int sumi_editor_supported(void);

// Trusted host resource only; process-scoped, never installed in the OS font library.
int sumi_editor_register_font(const char *path, const char *expected_family, char **error);
int sumi_editor_register_cascade(const char *json, char **error);

// Only the current key window's actual Sumi text responder; no caller-supplied identity.
int sumi_editor_menu_command(const char *command);
