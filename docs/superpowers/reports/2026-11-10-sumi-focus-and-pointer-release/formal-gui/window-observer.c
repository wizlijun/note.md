#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <stdio.h>
static const char *directory;
static unsigned sample;
static void json_string(GString *out, const char *text) {
 g_string_append_c(out,'"');for(const unsigned char *p=(const unsigned char *)(text?text:"");*p;p++){if(*p=='"'||*p=='\\'){g_string_append_c(out,'\\');g_string_append_c(out,*p);}else if(*p<32){g_string_append_printf(out,"\\u%04x",*p);}else g_string_append_c(out,*p);}g_string_append_c(out,'"');
}
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
 if(GTK_IS_WINDOW(widget)) {
  const char *title=gtk_window_get_title(GTK_WINDOW(widget));g_string_append(out,",\"title\":");json_string(out,title);
  GdkWindow *w=gtk_widget_get_window(widget);g_string_append_printf(out,",\"decorated\":%s,\"resizable\":%s,\"windowState\":%u",gtk_window_get_decorated(GTK_WINDOW(widget))?"true":"false",gtk_window_get_resizable(GTK_WINDOW(widget))?"true":"false",w?gdk_window_get_state(w):0);
 }
 if(GTK_IS_TEXT_VIEW(widget)) {
  GtkTextView *view=GTK_TEXT_VIEW(widget);GdkRectangle visible;gtk_text_view_get_visible_rect(view,&visible);
  PangoContext *context=gtk_widget_get_pango_context(widget);const PangoFontDescription *font=pango_context_get_font_description(context);char *font_name=pango_font_description_to_string(font);
  g_string_append(out,",\"font\":");json_string(out,font_name);g_free(font_name);
  g_string_append_printf(out,",\"fontSizePango\":%d,\"fontSizeAbsolute\":%s,\"metrics\":[",pango_font_description_get_size(font),pango_font_description_get_size_is_absolute(font)?"true":"false");
  const char *samples[]={"M","Ag中"};for(int i=0;i<2;i++){PangoLayout *layout=gtk_widget_create_pango_layout(widget,samples[i]);int w,h;PangoRectangle ink;pango_layout_get_size(layout,&w,&h);pango_layout_get_pixel_extents(layout,&ink,NULL);g_string_append_printf(out,"%s{\"sample\":",i?",":"");json_string(out,samples[i]);g_string_append_printf(out,",\"width\":%.6f,\"height\":%.6f,\"ink\":[%d,%d,%d,%d]}",w/(double)PANGO_SCALE,h/(double)PANGO_SCALE,ink.x,ink.y,ink.width,ink.height);g_object_unref(layout);}g_string_append(out,"]");
  GtkTextBuffer *buffer=gtk_text_view_get_buffer(view);GtkTextIter at,first,end;gtk_text_buffer_get_iter_at_mark(buffer,&at,gtk_text_buffer_get_insert(buffer));gtk_text_buffer_get_start_iter(buffer,&first);gtk_text_buffer_get_end_iter(buffer,&end);GdkRectangle caret,line;gtk_text_view_get_cursor_locations(view,&at,&caret,NULL);gtk_text_view_get_iter_location(view,&first,&line);
  char *text=gtk_text_buffer_get_text(buffer,&first,&end,TRUE);g_string_append(out,",\"text\":");json_string(out,text);g_free(text);
  g_string_append_printf(out,",\"insertOffset\":%d,\"gtkCursor\":[%d,%d,%d,%d],\"firstLine\":[%d,%d,%d,%d]",gtk_text_iter_get_offset(&at),caret.x,caret.y,caret.width,caret.height,line.x,line.y,line.width,line.height);

  g_string_append_printf(out,",\"wrap\":%d,\"textMargins\":[%d,%d,%d,%d],\"visibleRect\":[%d,%d,%d,%d]",gtk_text_view_get_wrap_mode(view),gtk_text_view_get_left_margin(view),gtk_text_view_get_right_margin(view),gtk_text_view_get_top_margin(view),gtk_text_view_get_bottom_margin(view),visible.x,visible.y,visible.width,visible.height);
 }
 if(GTK_IS_SCROLLED_WINDOW(widget)) {
  GtkAdjustment *h=gtk_scrolled_window_get_hadjustment(GTK_SCROLLED_WINDOW(widget));
  g_string_append_printf(out,",\"horizontal\":[%.2f,%.2f,%.2f]",gtk_adjustment_get_value(h),gtk_adjustment_get_upper(h),gtk_adjustment_get_page_size(h));
 }
 if(WEBKIT_IS_WEB_VIEW(widget)) {
  g_string_append_printf(out,",\"zoom\":%.6f",webkit_web_view_get_zoom_level(WEBKIT_WEB_VIEW(widget)));
  char *path=g_strdup_printf("%s/dom-%p.json",directory,widget);
  const char *js="JSON.stringify({time:Date.now(),window:window.__TAURI_INTERNALS__?.metadata?.currentWindow,innerWidth,innerHeight,dpr:devicePixelRatio,body:document.body.innerText.slice(0,20000),dataset:{...document.documentElement.dataset,...document.body.dataset},appDataset:{...document.querySelector('#app')?.dataset},controls:Array.from(document.querySelectorAll('button,input,textarea,a,[role=checkbox],#tools,#notice-slot,.native-editor-region')).filter(e=>e.getBoundingClientRect().width>0).map(e=>({tag:e.tagName,id:e.id,text:e.innerText?.slice(0,160),aria:e.getAttribute('aria-label'),pressed:e.getAttribute('aria-pressed'),title:e.getAttribute('title'),value:e.value,type:e.type,checked:e.checked,rect:e.getBoundingClientRect().toJSON()}))})";
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
 directory=g_getenv("NOTEMD_WINDOW_AUDIT_DIR");if(directory&&*directory){g_mkdir_with_parents(directory,0700);g_timeout_add_seconds(1,dump,NULL);}
}
