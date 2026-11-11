#define _GNU_SOURCE
#include <ctype.h>
#include <linux/input-event-codes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include "keyboard-protocol.h"

/* Test-only input with one stable standard keymap, unlike per-command wtype maps. */
static struct zwp_virtual_keyboard_manager_v1 *manager;
static struct wl_seat *seat;
static void global(void *data, struct wl_registry *r, uint32_t name, const char *iface, uint32_t version) {
 if (!strcmp(iface,"zwp_virtual_keyboard_manager_v1")) manager=wl_registry_bind(r,name,&zwp_virtual_keyboard_manager_v1_interface,1);
 if (!strcmp(iface,"wl_seat")) seat=wl_registry_bind(r,name,&wl_seat_interface,1);
}
static void removed(void *data,struct wl_registry *r,uint32_t name){}
static const struct wl_registry_listener listener={global,removed};
static int keycode(const char *name) {
 static const struct { const char *name; int code; } keys[]={
  {"Left",KEY_LEFT},{"Right",KEY_RIGHT},{"Up",KEY_UP},{"Down",KEY_DOWN},
  {"Home",KEY_HOME},{"End",KEY_END},{"PageUp",KEY_PAGEUP},{"PageDown",KEY_PAGEDOWN},
  {"BackSpace",KEY_BACKSPACE},{"Delete",KEY_DELETE},{"Return",KEY_ENTER},
  {"Tab",KEY_TAB},{"Escape",KEY_ESC},{"Space",KEY_SPACE},{"F10",KEY_F10},
  {"space",KEY_SPACE},{".",KEY_DOT},{"period",KEY_DOT},{",",KEY_COMMA},{"comma",KEY_COMMA},
  {"'",KEY_APOSTROPHE},{"apostrophe",KEY_APOSTROPHE},{"Compose",KEY_COMPOSE},{"Multi_key",KEY_COMPOSE},
  {"Ctrl",KEY_LEFTCTRL},{"Shift",KEY_LEFTSHIFT},{"Alt",KEY_LEFTALT},{"Super",KEY_LEFTMETA}
 };
 for(size_t i=0;i<sizeof(keys)/sizeof(keys[0]);i++) if(!strcmp(name,keys[i].name)) return keys[i].code;
 if(strlen(name)==1) {
  if(name[0]>='1' && name[0]<='9')return KEY_1+name[0]-'1';
  if(name[0]=='0')return KEY_0;
  const char *rows[]={"qwertyuiop","asdfghjkl","zxcvbnm"};
  const int first[]={KEY_Q,KEY_A,KEY_Z};
  for(int i=0;i<3;i++) { const char *p=strchr(rows[i],tolower((unsigned char)name[0])); if(p) return first[i]+(int)(p-rows[i]); }
 }
 return -1;
}
static void key(struct wl_display *display,struct zwp_virtual_keyboard_v1 *keyboard,struct xkb_state *state,int code,int down) {
 struct timespec now;clock_gettime(CLOCK_MONOTONIC,&now);
 zwp_virtual_keyboard_v1_key(keyboard,(uint32_t)(now.tv_sec*1000+now.tv_nsec/1000000),code,down);
 xkb_state_update_key(state,code+8,down?XKB_KEY_DOWN:XKB_KEY_UP);
 zwp_virtual_keyboard_v1_modifiers(keyboard,
  xkb_state_serialize_mods(state,XKB_STATE_MODS_DEPRESSED),
  xkb_state_serialize_mods(state,XKB_STATE_MODS_LATCHED),
  xkb_state_serialize_mods(state,XKB_STATE_MODS_LOCKED),
  xkb_state_serialize_layout(state,XKB_STATE_LAYOUT_EFFECTIVE));
 wl_display_roundtrip(display);
 nanosleep(&(struct timespec){.tv_nsec=30000000},NULL);
}
int main(int argc,char **argv) {
 long hold_ms=0;const char *hold_text=getenv("SUMI_KEY_HOLD_MS");
 if(hold_text) {
  char *end;hold_ms=strtol(hold_text,&end,10);
  if(end==hold_text || *end || hold_ms<0 || hold_ms>2000) {
   fprintf(stderr,"SUMI_KEY_HOLD_MS must be an integer from 0 to 2000\n");return 2;
  }
 }
 /* Validate every chord before connecting or sending any input. */
 for(int i=1;i<argc;i++) {
  char *copy=strdup(argv[i]);int count=0;
  for(char *part=strtok(copy,"+");part;part=strtok(NULL,"+")) {
   if(keycode(part)<0 || ++count>5) { fprintf(stderr,"Unknown/invalid key chord: %s\n",argv[i]);free(copy);return 2; }
  }
  free(copy);if(!count)return 2;
 }
 struct wl_display *display=wl_display_connect(NULL);if(!display)return 3;
 struct wl_registry *registry=wl_display_get_registry(display);wl_registry_add_listener(registry,&listener,NULL);wl_display_roundtrip(display);
 if(!manager||!seat)return 4;
 struct xkb_context *context=xkb_context_new(XKB_CONTEXT_NO_FLAGS);
 const struct xkb_rule_names names={.rules="evdev",.model="pc105",.layout="us",.variant="",.options="compose:menu"};
 struct xkb_keymap *map=xkb_keymap_new_from_names(context,&names,XKB_KEYMAP_COMPILE_NO_FLAGS);if(!map)return 5;
 struct xkb_state *state=xkb_state_new(map);
 char *text=xkb_keymap_get_as_string(map,XKB_KEYMAP_FORMAT_TEXT_V1);size_t size=strlen(text)+1;
 int fd=memfd_create("sumi-probe-keymap",MFD_CLOEXEC);if(fd<0 || write(fd,text,size)!=(ssize_t)size)return 6;
 struct zwp_virtual_keyboard_v1 *keyboard=zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(manager,seat);
 zwp_virtual_keyboard_v1_keymap(keyboard,WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1,fd,size);wl_display_roundtrip(display);close(fd);free(text);
 nanosleep(&(struct timespec){.tv_nsec=200000000},NULL);
 for(int i=1;i<argc;i++) {
  char *copy=strdup(argv[i]);int codes[5],count=0;
  for(char *part=strtok(copy,"+");part;part=strtok(NULL,"+")) codes[count++]=keycode(part);
  for(int j=0;j<count;j++)key(display,keyboard,state,codes[j],1);
  if(hold_ms)nanosleep(&(struct timespec){.tv_sec=hold_ms/1000,.tv_nsec=(hold_ms%1000)*1000000},NULL);
  for(int j=count-1;j>=0;j--)key(display,keyboard,state,codes[j],0);
  free(copy);
 }
 nanosleep(&(struct timespec){.tv_nsec=200000000},NULL);
 const char *hold=getenv("SUMI_KEYBOARD_HOLD_SECONDS");if(hold)nanosleep(&(struct timespec){.tv_sec=strtol(hold,NULL,10)},NULL);
 zwp_virtual_keyboard_v1_destroy(keyboard);wl_display_roundtrip(display);wl_display_disconnect(display);
 xkb_state_unref(state);xkb_keymap_unref(map);xkb_context_unref(context);return 0;
}
