#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wayland-client.h>
#include "protocol.h"
static struct zwlr_virtual_pointer_manager_v1 *manager;
static struct wl_seat *seat;
static void global(void *data, struct wl_registry *r, uint32_t name, const char *iface, uint32_t version) {
 if (!strcmp(iface,"zwlr_virtual_pointer_manager_v1")) manager=wl_registry_bind(r,name,&zwlr_virtual_pointer_manager_v1_interface,1);
 if (!strcmp(iface,"wl_seat")) seat=wl_registry_bind(r,name,&wl_seat_interface,1);
}
static void removed(void *data,struct wl_registry *r,uint32_t name){}
static const struct wl_registry_listener listener={global,removed};
int main(int argc,char **argv) {
 if(argc!=5)return 2;
 struct wl_display *d=wl_display_connect(NULL);if(!d)return 3;
 struct wl_registry *r=wl_display_get_registry(d);wl_registry_add_listener(r,&listener,NULL);wl_display_roundtrip(d);
 if(!manager)return 4;
 struct zwlr_virtual_pointer_v1 *p=zwlr_virtual_pointer_manager_v1_create_virtual_pointer(manager,seat);
 struct timespec ts;clock_gettime(CLOCK_MONOTONIC,&ts);uint32_t ms=ts.tv_sec*1000+ts.tv_nsec/1000000;
 zwlr_virtual_pointer_v1_button(p,ms,272,0);zwlr_virtual_pointer_v1_frame(p);wl_display_roundtrip(d);
 zwlr_virtual_pointer_v1_motion_absolute(p,ms,atoi(argv[1]),atoi(argv[2]),atoi(argv[3]),atoi(argv[4]));
 zwlr_virtual_pointer_v1_frame(p);wl_display_roundtrip(d); nanosleep(&(struct timespec){.tv_nsec=150000000},NULL);
 zwlr_virtual_pointer_v1_button(p,ms+1,272,1);zwlr_virtual_pointer_v1_frame(p);wl_display_roundtrip(d); nanosleep(&(struct timespec){.tv_nsec=150000000},NULL);
 zwlr_virtual_pointer_v1_button(p,ms+2,272,0);zwlr_virtual_pointer_v1_frame(p);wl_display_roundtrip(d);
 nanosleep(&(struct timespec){.tv_nsec=150000000},NULL);
 const char *hold=getenv("SUMI_POINTER_HOLD_SECONDS");
 if(hold) nanosleep(&(struct timespec){.tv_sec=strtol(hold,NULL,10)},NULL);
 zwlr_virtual_pointer_v1_destroy(p);wl_display_roundtrip(d);wl_display_disconnect(d);return 0;
}
