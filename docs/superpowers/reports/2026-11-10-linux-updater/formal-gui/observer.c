#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
static const char *directory;
static void finished(GObject *object, GAsyncResult *result, gpointer data) {
 GError *error = NULL;
 JSCValue *value = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(object), result, &error);
 if (value) { char *text = jsc_value_to_string(value); g_file_set_contents(data, text, -1, NULL); g_free(text); g_object_unref(value); }
 else if (error) { g_file_set_contents(data, error->message, -1, NULL); g_error_free(error); }
 g_free(data);
}
static void inspect(GtkWidget *widget, gpointer ignored) {
 if (WEBKIT_IS_WEB_VIEW(widget)) {
  const char *js = "if(window.__TAURI_INTERNALS__?.invoke&&!window.__updaterAuditRequested){window.__updaterAuditRequested=true;Promise.all([window.__TAURI_INTERNALS__.invoke('desktop_capabilities'),window.__TAURI_INTERNALS__.invoke('plugin_market_host_triple'),window.__TAURI_INTERNALS__.invoke('plugin:app|version')]).then(([capabilities,triple,version])=>{window.__updaterAuditIdentity={capabilities,triple,version}}).catch(e=>{window.__updaterAuditIdentity={error:String(e)}})};JSON.stringify({time:new Date().toISOString(),identity:window.__updaterAuditIdentity,window:window.__TAURI_INTERNALS__?.metadata?.currentWindow,innerWidth,innerHeight,body:document.body.innerText.slice(0,14000),controls:Array.from(document.querySelectorAll('button,input,a,[role=checkbox]')).filter(e=>e.getBoundingClientRect().width>0).map(e=>({tag:e.tagName,text:e.innerText,aria:e.getAttribute('aria-label'),title:e.getAttribute('title'),type:e.type,checked:e.checked,rect:e.getBoundingClientRect().toJSON()}))})";
  char *path = g_strdup_printf("%s/dom-%p.json", directory, widget);
  webkit_web_view_evaluate_javascript(WEBKIT_WEB_VIEW(widget), js, -1, NULL, NULL, NULL, finished, path);
 }
 if (GTK_IS_CONTAINER(widget)) gtk_container_forall(GTK_CONTAINER(widget), inspect, NULL);
}
static gboolean sample(gpointer ignored) {
 GList *windows = gtk_window_list_toplevels();
 for (GList *p = windows; p; p = p->next) inspect(p->data, NULL);
 g_list_free(windows);
 return G_SOURCE_CONTINUE;
}
G_MODULE_EXPORT void gtk_module_init(gint *argc, gchar ***argv) {
 directory = g_getenv("NOTEMD_UPDATER_AUDIT_DIR");
 if (directory && *directory) { g_mkdir_with_parents(directory,0700); g_timeout_add_seconds(1,sample,NULL); }
}
