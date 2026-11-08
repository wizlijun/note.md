#pragma once
#include <stdint.h>
void *sumi_sound_create(const char *bank_json, int offline, char **error);
int sumi_sound_ready(void *context);
void sumi_sound_play(void *context, const char *role);
void sumi_sound_stop(void *context);
void sumi_sound_destroy(void *context);
void sumi_sound_free(char *value);
// Offline probe only. No keyboard access or system playback.
int sumi_sound_render(void *context, uint32_t frames, float *peak, uint32_t *voices);
