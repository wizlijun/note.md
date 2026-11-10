#include <gtk/gtk.h>
#include <stdio.h>
static const char *directory;
static FILE *stream;
static const char *sample_kind;
static gint64 frame_counter, frame_time;
static unsigned long sequence;
static char *current_case;
static void rect(FILE *f,GdkRectangle r){fprintf(f,"[%d,%d,%d,%d]",r.x,r.y,r.width,r.height);}
static void allocation(FILE *f,GtkWidget *w){GtkAllocation a;gtk_widget_get_allocation(w,&a);fprintf(f,"[%d,%d,%d,%d]",a.x,a.y,a.width,a.height);}
static void json_string(FILE *f,const char *s){fputc('"',f);for(const unsigned char *p=(const unsigned char *)(s?s:"");*p;p++){if(*p=='"'||*p=='\\'){fputc('\\',f);fputc(*p,f);}else if(*p<32)fprintf(f,"\\u%04x",*p);else fputc(*p,f);}fputc('"',f);}
static void inspect(GtkWidget *w,gpointer ignored){
 if(!gtk_widget_get_mapped(w))return;
 if(GTK_IS_TEXT_VIEW(w)){
  GtkTextView *v=GTK_TEXT_VIEW(w);GtkTextBuffer *b=gtk_text_view_get_buffer(v);GtkTextIter it;gtk_text_buffer_get_iter_at_mark(b,&it,gtk_text_buffer_get_insert(b));GdkRectangle cursor,visible;gtk_text_view_get_cursor_locations(v,&it,&cursor,NULL);gtk_text_view_get_visible_rect(v,&visible);int wx,wy;gtk_text_view_buffer_to_window_coords(v,GTK_TEXT_WINDOW_WIDGET,cursor.x,cursor.y,&wx,&wy);
  GtkWidget *top=gtk_widget_get_toplevel(w),*parent=w;while(parent&&!GTK_IS_SCROLLED_WINDOW(parent))parent=gtk_widget_get_parent(parent);if(!parent)return;
  GtkScrolledWindow *scroll=GTK_SCROLLED_WINDOW(parent);GtkAdjustment *a=gtk_scrolled_window_get_vadjustment(scroll);GtkPolicyType hp,vp;gtk_scrolled_window_get_policy(scroll,&hp,&vp);GtkWidget *hs=gtk_scrolled_window_get_hscrollbar(scroll),*vs=gtk_scrolled_window_get_vscrollbar(scroll);
  PangoContext *ctx=gtk_widget_get_pango_context(w);const PangoFontDescription *desc=pango_context_get_font_description(ctx);char *font=pango_font_description_to_string(desc);PangoFontMetrics *metrics=pango_context_get_metrics(ctx,desc,pango_context_get_language(ctx));
  char *marker_path=g_build_filename(directory,"case.txt",NULL),*marker=NULL;g_file_get_contents(marker_path,&marker,NULL,NULL);g_free(marker_path);
  char *case_name=g_strdup(marker?marker:"unmarked");g_strstrip(case_name);if(!*case_name){g_free(case_name);case_name=g_strdup("unmarked");}for(char *p=case_name;*p;p++)if(!g_ascii_isalnum(*p)&&*p!='-'&&*p!='_')*p='_';
  if(g_strcmp0(current_case,case_name)!=0){char *filename=g_strdup_printf("frames-%s.jsonl",case_name);char *path=g_build_filename(directory,filename,NULL);FILE *next=fopen(path,"a");g_free(path);g_free(filename);if(next){fclose(stream);stream=next;setvbuf(stream,NULL,_IOLBF,0);g_free(current_case);current_case=g_strdup(case_name);}}g_free(case_name);

  fprintf(stream,"{\"seq\":%lu,\"monotonic_us\":%"G_GINT64_FORMAT",\"kind\":",++sequence,g_get_monotonic_time());json_string(stream,sample_kind);fprintf(stream,",\"frame\":%"G_GINT64_FORMAT",\"frame_us\":%"G_GINT64_FORMAT",\"case\":",frame_counter,frame_time);json_string(stream,marker?marker:"");g_free(marker);
  fprintf(stream,",\"view\":\"%p\",\"scale\":%d,\"focus\":%s,\"line\":%d,\"line_offset\":%d,\"insert_offset\":%d,\"char_count\":%d,\"line_count\":%d,\"window_xy\":[%d,%d],\"gtk_cursor\":",w,gtk_widget_get_scale_factor(w),gtk_widget_has_focus(w)?"true":"false",gtk_text_iter_get_line(&it),gtk_text_iter_get_line_offset(&it),gtk_text_iter_get_offset(&it),gtk_text_buffer_get_char_count(b),gtk_text_buffer_get_line_count(b),wx,wy);rect(stream,cursor);
  fprintf(stream,",\"visible_rect\":");rect(stream,visible);fprintf(stream,",\"view_allocation\":");allocation(stream,w);fprintf(stream,",\"outer_allocation\":");allocation(stream,top);
  GdkWindow *gdk=gtk_widget_get_window(top);int gx=0,gy=0,gw=0,gh=0;if(gdk)gdk_window_get_geometry(gdk,&gx,&gy,&gw,&gh);fprintf(stream,",\"gdk_outer_geometry\":[%d,%d,%d,%d],\"window_state\":%u",gx,gy,gw,gh,gdk?gdk_window_get_state(gdk):0);
  fprintf(stream,",\"vadjustment\":{\"value\":%.9f,\"lower\":%.9f,\"upper\":%.9f,\"page_size\":%.9f},\"font\":",gtk_adjustment_get_value(a),gtk_adjustment_get_lower(a),gtk_adjustment_get_upper(a),gtk_adjustment_get_page_size(a));json_string(stream,font);g_free(font);
  fprintf(stream,",\"font_size_pango\":%d,\"font_absolute\":%s,\"font_ascent\":%.6f,\"font_descent\":%.6f,\"scroll_policy\":[%d,%d],\"shadow_type\":%d,\"hscrollbar\":{\"visible\":%s,\"mapped\":%s,\"allocation\":",pango_font_description_get_size(desc),pango_font_description_get_size_is_absolute(desc)?"true":"false",pango_font_metrics_get_ascent(metrics)/(double)PANGO_SCALE,pango_font_metrics_get_descent(metrics)/(double)PANGO_SCALE,hp,vp,gtk_scrolled_window_get_shadow_type(scroll),gtk_widget_get_visible(hs)?"true":"false",gtk_widget_get_mapped(hs)?"true":"false");allocation(stream,hs);
  fprintf(stream,"},\"vscrollbar\":{\"visible\":%s,\"mapped\":%s,\"allocation\":",gtk_widget_get_visible(vs)?"true":"false",gtk_widget_get_mapped(vs)?"true":"false");allocation(stream,vs);fprintf(stream,"}}\n");pango_font_metrics_unref(metrics);
 }
 if(GTK_IS_CONTAINER(w))gtk_container_forall(GTK_CONTAINER(w),inspect,NULL);
}
static gboolean target(GtkWidget *w){return GTK_IS_WINDOW(w)&&g_strcmp0(gtk_window_get_title(GTK_WINDOW(w)),"Sumi Typewriter")==0;}
static void after_paint(GdkFrameClock *clock,GtkWidget *window){sample_kind="after-paint";frame_counter=gdk_frame_clock_get_frame_counter(clock);frame_time=gdk_frame_clock_get_frame_time(clock);inspect(window,NULL);}
static gboolean poll(gpointer ignored){
 GList *windows=gtk_window_list_toplevels();for(GList *p=windows;p;p=p->next){GtkWidget *w=p->data;if(!target(w)||!gtk_widget_get_mapped(w))continue;GdkFrameClock *clock=gtk_widget_get_frame_clock(w);if(clock&&!g_object_get_data(G_OBJECT(clock),"notemd-focus-audit-attached")){g_object_set_data(G_OBJECT(clock),"notemd-focus-audit-attached",GINT_TO_POINTER(1));g_signal_connect_object(clock,"after-paint",G_CALLBACK(after_paint),w,0);}sample_kind="poll";frame_counter=clock?gdk_frame_clock_get_frame_counter(clock):-1;frame_time=clock?gdk_frame_clock_get_frame_time(clock):0;inspect(w,NULL);}g_list_free(windows);return G_SOURCE_CONTINUE;
}
G_MODULE_EXPORT void gtk_module_init(gint *argc,gchar ***argv){directory=g_getenv("NOTEMD_FOCUS_AUDIT_DIR");if(directory&&*directory){g_mkdir_with_parents(directory,0700);char *path=g_build_filename(directory,"frames.jsonl",NULL);stream=fopen(path,"a");g_free(path);if(stream){setvbuf(stream,NULL,_IOLBF,0);g_timeout_add(50,poll,NULL);}}}
