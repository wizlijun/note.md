#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <stdio.h>
static const char *directory;
static unsigned sample;
static void javascript_finished(GObject *object,GAsyncResult *result,gpointer data) {
 GError *error=NULL;
 JSCValue *value=webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(object),result,&error);
 if(value) { char *text=jsc_value_to_string(value); g_file_set_contents(data,text,-1,NULL);g_free(text);g_object_unref(value); }
 else if(error) { g_file_set_contents(data,error->message,-1,NULL);g_error_free(error); }
 g_free(data);
}
static void widget_dump(GtkWidget *widget,gpointer data) {
 GString *out=data;GtkAllocation a;gtk_widget_get_allocation(widget,&a);int rw,rh;gtk_widget_get_size_request(widget,&rw,&rh);
 g_string_append_printf(out,"{\"type\":\"%s\",\"pointer\":\"%p\",\"allocation\":[%d,%d,%d,%d],\"request\":[%d,%d],\"margins\":[%d,%d,%d,%d],\"scale\":%d,\"visible\":%s,\"mapped\":%s,\"focus\":%s",G_OBJECT_TYPE_NAME(widget),widget,a.x,a.y,a.width,a.height,rw,rh,gtk_widget_get_margin_start(widget),gtk_widget_get_margin_end(widget),gtk_widget_get_margin_top(widget),gtk_widget_get_margin_bottom(widget),gtk_widget_get_scale_factor(widget),gtk_widget_get_visible(widget)?"true":"false",gtk_widget_get_mapped(widget)?"true":"false",gtk_widget_has_focus(widget)?"true":"false");
 if(GTK_IS_TEXT_VIEW(widget)) {
  GtkTextView *view=GTK_TEXT_VIEW(widget);GdkRectangle visible;gtk_text_view_get_visible_rect(view,&visible);
  g_string_append_printf(out,",\"wrap\":%d,\"textMargins\":[%d,%d,%d,%d],\"visibleRect\":[%d,%d,%d,%d]",gtk_text_view_get_wrap_mode(view),gtk_text_view_get_left_margin(view),gtk_text_view_get_right_margin(view),gtk_text_view_get_top_margin(view),gtk_text_view_get_bottom_margin(view),visible.x,visible.y,visible.width,visible.height);
 }
 if(GTK_IS_SCROLLED_WINDOW(widget)) {
  GtkAdjustment *h=gtk_scrolled_window_get_hadjustment(GTK_SCROLLED_WINDOW(widget));
  g_string_append_printf(out,",\"horizontal\":[%.2f,%.2f,%.2f]",gtk_adjustment_get_value(h),gtk_adjustment_get_upper(h),gtk_adjustment_get_page_size(h));
 }
 if(WEBKIT_IS_WEB_VIEW(widget)) {
  g_string_append_printf(out,",\"zoom\":%.6f",webkit_web_view_get_zoom_level(WEBKIT_WEB_VIEW(widget)));
  char *path=g_strdup_printf("%s/dom-%p.json",directory,widget);
  const char *js="if(window.__TAURI_INTERNALS__?.invoke&&!window.__sumiGeometryPending){window.__sumiGeometryPending=true;const label=window.__TAURI_INTERNALS__.metadata.currentWindow.label;Promise.all([window.__TAURI_INTERNALS__.invoke('plugin:window|inner_size',{label}),window.__TAURI_INTERNALS__.invoke('plugin:window|scale_factor',{label}),window.__TAURI_INTERNALS__.invoke('plugin:webview|webview_size',{label:window.__TAURI_INTERNALS__.metadata.currentWebview.label})]).then(([size,scale,webviewSize])=>{window.__sumiGeometryTauri={label,size,scale,webviewSize}}).catch(e=>{window.__sumiGeometryTauri={error:String(e)}}).finally(()=>{window.__sumiGeometryPending=false})};JSON.stringify({time:Date.now(),tauri:window.__sumiGeometryTauri,innerWidth:window.innerWidth,innerHeight:window.innerHeight,dpr:window.devicePixelRatio,outerWidth:window.outerWidth,regions:Array.from(document.querySelectorAll('.native-editor-region,.native-file-view')).map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON(),zoom:getComputedStyle(e).zoom})),rootZoom:getComputedStyle(document.documentElement).zoom})";
  webkit_web_view_evaluate_javascript(WEBKIT_WEB_VIEW(widget),js,-1,NULL,NULL,NULL,javascript_finished,path);
 }
 g_string_append(out,"}\n");
 if(GTK_IS_CONTAINER(widget))gtk_container_forall(GTK_CONTAINER(widget),widget_dump,out);
}
static gboolean dump(gpointer ignored) {
 GString *out=g_string_new(NULL);g_string_append_printf(out,"{\"sample\":%u,\"timeUs\":%"G_GINT64_FORMAT"}\n",++sample,g_get_real_time());
 GList *windows=gtk_window_list_toplevels();for(GList *p=windows;p;p=p->next)widget_dump(p->data,out);g_list_free(windows);
 char *path=g_build_filename(directory,"gtk-tree.jsonl",NULL);g_file_set_contents(path,out->str,out->len,NULL);g_free(path);g_string_free(out,TRUE);return G_SOURCE_CONTINUE;
}
G_MODULE_EXPORT void gtk_module_init(gint *argc,gchar ***argv) {
 directory=g_getenv("SUMI_GTK_GEOMETRY_DIR");if(directory&&*directory){g_mkdir_with_parents(directory,0700);g_timeout_add_seconds(2,dump,NULL);}
}
