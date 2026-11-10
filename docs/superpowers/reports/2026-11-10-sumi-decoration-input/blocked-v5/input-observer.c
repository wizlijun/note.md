#include <gtk/gtk.h>
#include <stdio.h>
static FILE *out;
static gboolean event(GtkWidget *w,GdkEvent *e,gpointer ignored){if(e->type==GDK_BUTTON_PRESS||e->type==GDK_BUTTON_RELEASE||e->type==GDK_SCROLL){gdouble x=0,y=0,dx=0,dy=0;gdk_event_get_coords(e,&x,&y);gdk_event_get_scroll_deltas(e,&dx,&dy);GdkScrollDirection d=GDK_SCROLL_SMOOTH;gdk_event_get_scroll_direction(e,&d);fprintf(out,"{\"us\":%"G_GINT64_FORMAT",\"widget\":\"%s\",\"pointer\":\"%p\",\"type\":%d,\"xy\":[%.2f,%.2f],\"delta\":[%.2f,%.2f],\"direction\":%d}\n",g_get_monotonic_time(),G_OBJECT_TYPE_NAME(w),w,e->type,x,y,dx,dy,d);}return FALSE;}
static void walk(GtkWidget*w,gpointer ignored){if(!g_object_get_data(G_OBJECT(w),"sumi-input-audit")){g_object_set_data(G_OBJECT(w),"sumi-input-audit",GINT_TO_POINTER(1));g_signal_connect(w,"event",G_CALLBACK(event),NULL);}if(GTK_IS_CONTAINER(w))gtk_container_forall(GTK_CONTAINER(w),walk,NULL);}
static gboolean scan(gpointer ignored){GList*windows=gtk_window_list_toplevels();for(GList*p=windows;p;p=p->next)walk(p->data,NULL);g_list_free(windows);return TRUE;}
G_MODULE_EXPORT void gtk_module_init(gint*argc,gchar***argv){const char*p=g_getenv("NOTEMD_INPUT_AUDIT_FILE");if(p){out=fopen(p,"a");if(out){setvbuf(out,NULL,_IOLBF,0);g_timeout_add(500,scan,NULL);}}}
