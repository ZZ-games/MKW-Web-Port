// Does emscripten_fiber_swap work under JSPI? Ping-pong between main and one fiber.
#include <emscripten/fiber.h>
#include <cstdio>
#include <cstdlib>
static emscripten_fiber_t g_main, g_other;
static void entry(void*) {
  for (int i = 0; i < 3; ++i) { std::printf("fiber %d\n", i); emscripten_fiber_swap(&g_other, &g_main); }
  std::printf("fiber done\n"); emscripten_fiber_swap(&g_other, &g_main);
}
int main() {
  static char asyncStackMain[64 * 1024], cStack[256 * 1024], asyncStack[64 * 1024];
  emscripten_fiber_init_from_current_context(&g_main, asyncStackMain, sizeof(asyncStackMain));
  emscripten_fiber_init(&g_other, entry, nullptr, cStack, sizeof(cStack), asyncStack, sizeof(asyncStack));
  for (int i = 0; i < 4; ++i) { std::printf("main %d\n", i); emscripten_fiber_swap(&g_main, &g_other); }
  std::printf("main done\n");
}
