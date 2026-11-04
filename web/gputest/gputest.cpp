// WebGPU setup probe for the MKW web port. Answers, in the target browser:
//   1. Can this thread (pthread or main) get an adapter and device with blocking WaitAny (JSPI)?
//   2. Can it render to the page canvas, presenting by yielding with emscripten_sleep?
//   3. Does a blocking GPU readback (MapAsync + WaitAny) work, as aurora's EFB peeks need?
//   4. Which features/limits does the adapter report (incl. native immediate data)?
// Results go to stdout and are POSTed to /log on the local server.
#include <emscripten.h>
#include <emscripten/threading.h>
#include <webgpu/webgpu_cpp.h>

#include <chrono>
#include <thread>

#include <pthread.h>
#include <cstdarg>
#include <cstdio>
#include <string>

namespace {

std::string g_log;

void logf(const char* format, ...) {
  char line[1024];
  va_list args;
  va_start(args, format);
  std::vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  std::printf("%s\n", line);
  g_log += line;
  g_log += '\n';
}

void post_log(const char* variant) {
  EM_ASM(
      {
        fetch('/log?variant=' + UTF8ToString($0), {method : 'POST', body : UTF8ToString($1)});
      },
      variant, g_log.c_str());
}

const char* wait_status_name(wgpu::WaitStatus status) {
  switch (status) {
  case wgpu::WaitStatus::Success:
    return "Success";
  case wgpu::WaitStatus::TimedOut:
    return "TimedOut";
  case wgpu::WaitStatus::Error:
    return "Error";
  default:
    return "Other";
  }
}

std::string sv(wgpu::StringView view) { return view.data ? std::string(view.data, view.length) : std::string(); }

using Clock = std::chrono::steady_clock;
double ms_since(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

} // namespace

#ifndef PROBE_VARIANT
#define PROBE_VARIANT "unknown"
#endif

static int run_probe() {
  logf("variant: %s", PROBE_VARIANT);
  {
    // Can this thread suspend through JSPI at all? (emscripten_sleep yields to the event loop.)
    const auto sleepStart = Clock::now();
    emscripten_sleep(10);
    logf("emscripten_sleep(10) on this thread: ok, %.1f ms", ms_since(sleepStart));
  }
  logf("running on: %s", emscripten_is_main_runtime_thread() ? "main thread" : "pthread (worker)");
  logf("user agent: %s", reinterpret_cast<char*>(EM_ASM_PTR({ return stringToNewUTF8(navigator.userAgent); })));

  const wgpu::InstanceFeatureName timedWaitAny = wgpu::InstanceFeatureName::TimedWaitAny;
  wgpu::InstanceDescriptor instanceDesc{};
  instanceDesc.requiredFeatureCount = 1;
  instanceDesc.requiredFeatures = &timedWaitAny;
  wgpu::Instance instance = wgpu::CreateInstance(&instanceDesc);
  logf("instance: %s", instance ? "ok" : "FAILED");
  if (!instance) {
    post_log(PROBE_VARIANT);
    return 1;
  }

  // 1. Adapter and device through blocking WaitAny, exactly as aurora's gpu.cpp does it.
  wgpu::Adapter adapter;
  wgpu::RequestAdapterOptions adapterOptions{};
  adapterOptions.powerPreference = wgpu::PowerPreference::HighPerformance;
  auto t0 = Clock::now();
  wgpu::Future adapterFuture = instance.RequestAdapter(
      &adapterOptions, wgpu::CallbackMode::WaitAnyOnly,
      [&adapter](wgpu::RequestAdapterStatus status, wgpu::Adapter result, wgpu::StringView message) {
        if (status == wgpu::RequestAdapterStatus::Success) {
          adapter = std::move(result);
        } else {
          logf("adapter request failed: %s", sv(message).c_str());
        }
      });
  wgpu::WaitStatus waitStatus = instance.WaitAny(adapterFuture, 5'000'000'000ull);
  logf("adapter WaitAny: %s in %.1f ms, adapter %s", wait_status_name(waitStatus), ms_since(t0),
       adapter ? "ok" : "MISSING");
  if (!adapter) {
    post_log(PROBE_VARIANT);
    return 1;
  }

  wgpu::AdapterInfo info{};
  adapter.GetInfo(&info);
  logf("adapter: vendor='%s' architecture='%s' device='%s' description='%s'", sv(info.vendor).c_str(),
       sv(info.architecture).c_str(), sv(info.device).c_str(), sv(info.description).c_str());

  // 4. Features and limits aurora cares about.
  const struct {
    wgpu::FeatureName feature;
    const char* name;
  } kFeatures[] = {
      {wgpu::FeatureName::CoreFeaturesAndLimits, "core-features-and-limits"},
      {wgpu::FeatureName::TextureCompressionBC, "texture-compression-bc"},
      {wgpu::FeatureName::DualSourceBlending, "dual-source-blending"},
      {wgpu::FeatureName::TimestampQuery, "timestamp-query"},
      {wgpu::FeatureName::Float32Filterable, "float32-filterable"},
  };
  for (const auto& entry : kFeatures) {
    logf("feature %s: %s", entry.name, adapter.HasFeature(entry.feature) ? "yes" : "no");
  }
  wgpu::Limits limits{};
  adapter.GetLimits(&limits);
  logf("limits: maxImmediateSize=%u minUniformBufferOffsetAlignment=%u maxBindGroups=%u "
       "maxStorageBufferBindingSize=%llu maxTextureDimension2D=%u maxDynamicUniformBuffersPerPipelineLayout=%u",
       limits.maxImmediateSize, limits.minUniformBufferOffsetAlignment, limits.maxBindGroups,
       static_cast<unsigned long long>(limits.maxStorageBufferBindingSize), limits.maxTextureDimension2D,
       limits.maxDynamicUniformBuffersPerPipelineLayout);

  wgpu::Device device;
  wgpu::DeviceDescriptor deviceDesc{};
  deviceDesc.SetUncapturedErrorCallback([](const wgpu::Device&, wgpu::ErrorType type, wgpu::StringView message) {
    logf("uncaptured device error (%d): %s", static_cast<int>(type), sv(message).c_str());
  });
  t0 = Clock::now();
  wgpu::Future deviceFuture = adapter.RequestDevice(
      &deviceDesc, wgpu::CallbackMode::WaitAnyOnly,
      [&device](wgpu::RequestDeviceStatus status, wgpu::Device result, wgpu::StringView message) {
        if (status == wgpu::RequestDeviceStatus::Success) {
          device = std::move(result);
        } else {
          logf("device request failed: %s", sv(message).c_str());
        }
      });
  waitStatus = instance.WaitAny(deviceFuture, 5'000'000'000ull);
  logf("device WaitAny: %s in %.1f ms, device %s", wait_status_name(waitStatus), ms_since(t0),
       device ? "ok" : "MISSING");
  if (!device) {
    post_log(PROBE_VARIANT);
    return 1;
  }
  wgpu::Queue queue = device.GetQueue();

#if !defined(PROBE_IN_STD_THREAD) || defined(PROBE_CANVAS_TO_THREAD) // needs a canvas on this thread
  // 2. Surface on the page canvas, cleared frames presented by yielding to the event loop.
  wgpu::EmscriptenSurfaceSourceCanvasHTMLSelector canvasSource{};
  canvasSource.selector = "#canvas";
  wgpu::SurfaceDescriptor surfaceDesc{};
  surfaceDesc.nextInChain = &canvasSource;
  wgpu::Surface surface = instance.CreateSurface(&surfaceDesc);
  logf("surface: %s", surface ? "ok" : "FAILED");
  if (surface) {
    wgpu::SurfaceCapabilities caps{};
    surface.GetCapabilities(adapter, &caps);
    const wgpu::TextureFormat format = caps.formatCount > 0 ? caps.formats[0] : wgpu::TextureFormat::BGRA8Unorm;
    logf("surface formats: %zu, using %d", caps.formatCount, static_cast<int>(format));
    wgpu::SurfaceConfiguration config{};
    config.device = device;
    config.format = format;
    config.width = 640;
    config.height = 480;
    config.usage = wgpu::TextureUsage::RenderAttachment;
    config.presentMode = wgpu::PresentMode::Fifo;
    surface.Configure(&config);

    constexpr int kFrames = 120;
    t0 = Clock::now();
    for (int frame = 0; frame < kFrames; ++frame) {
      wgpu::SurfaceTexture surfaceTexture;
      surface.GetCurrentTexture(&surfaceTexture);
      if (!surfaceTexture.texture) {
        logf("frame %d: no surface texture (status %d)", frame, static_cast<int>(surfaceTexture.status));
        break;
      }
      const float phase = static_cast<float>(frame) / kFrames;
      wgpu::RenderPassColorAttachment attachment{};
      attachment.view = surfaceTexture.texture.CreateView();
      attachment.loadOp = wgpu::LoadOp::Clear;
      attachment.storeOp = wgpu::StoreOp::Store;
      attachment.clearValue = {0.1, 0.2 + 0.6 * phase, 0.8 - 0.6 * phase, 1.0};
      wgpu::RenderPassDescriptor passDesc{};
      passDesc.colorAttachmentCount = 1;
      passDesc.colorAttachments = &attachment;
      wgpu::CommandEncoder encoder = device.CreateCommandEncoder();
      encoder.BeginRenderPass(&passDesc).End();
      wgpu::CommandBuffer commands = encoder.Finish();
      queue.Submit(1, &commands);
      // The browser presents a canvas frame only when this thread returns to its event loop;
      // under JSPI emscripten_sleep suspends the wasm stack and does exactly that.
      emscripten_sleep(0);
    }
    const double elapsed = ms_since(t0);
    logf("render loop: %d frames in %.1f ms (%.1f fps)", kFrames, elapsed, kFrames * 1000.0 / elapsed);
  }

#endif
  // 3. Blocking readback: clear a texture, copy it to a buffer, MapAsync + WaitAny, check the pixel.
  {
    wgpu::TextureDescriptor texDesc{};
    texDesc.size = {64, 1, 1};
    texDesc.format = wgpu::TextureFormat::RGBA8Unorm;
    texDesc.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc;
    wgpu::Texture texture = device.CreateTexture(&texDesc);
    wgpu::BufferDescriptor bufDesc{};
    bufDesc.size = 256;
    bufDesc.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
    wgpu::Buffer buffer = device.CreateBuffer(&bufDesc);

    wgpu::RenderPassColorAttachment attachment{};
    attachment.view = texture.CreateView();
    attachment.loadOp = wgpu::LoadOp::Clear;
    attachment.storeOp = wgpu::StoreOp::Store;
    attachment.clearValue = {1.0, 0.5, 0.0, 1.0};
    wgpu::RenderPassDescriptor passDesc{};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &attachment;
    wgpu::CommandEncoder encoder = device.CreateCommandEncoder();
    encoder.BeginRenderPass(&passDesc).End();
    wgpu::TexelCopyTextureInfo src{};
    src.texture = texture;
    wgpu::TexelCopyBufferInfo dst{};
    dst.buffer = buffer;
    dst.layout.bytesPerRow = 256;
    const wgpu::Extent3D extent{64, 1, 1};
    encoder.CopyTextureToBuffer(&src, &dst, &extent);
    wgpu::CommandBuffer commands = encoder.Finish();
    queue.Submit(1, &commands);

    t0 = Clock::now();
    bool mapped = false;
    wgpu::Future mapFuture = buffer.MapAsync(wgpu::MapMode::Read, 0, 256, wgpu::CallbackMode::WaitAnyOnly,
                                             [&mapped](wgpu::MapAsyncStatus status, wgpu::StringView message) {
                                               mapped = status == wgpu::MapAsyncStatus::Success;
                                               if (!mapped) {
                                                 logf("map failed: %s", sv(message).c_str());
                                               }
                                             });
    waitStatus = instance.WaitAny(mapFuture, 2'000'000'000ull);
    logf("readback WaitAny: %s in %.2f ms", wait_status_name(waitStatus), ms_since(t0));
    if (mapped) {
      const auto* pixel = static_cast<const uint8_t*>(buffer.GetConstMappedRange(0, 4));
      logf("readback pixel: %u %u %u %u (expected 255 128 0 255, +/-1)", pixel[0], pixel[1], pixel[2], pixel[3]);
      buffer.Unmap();
    }

    // Repeated small readbacks, like per-frame EFB peeks: average latency.
    constexpr int kPeeks = 30;
    t0 = Clock::now();
    for (int i = 0; i < kPeeks; ++i) {
      wgpu::CommandEncoder peekEncoder = device.CreateCommandEncoder();
      peekEncoder.CopyTextureToBuffer(&src, &dst, &extent);
      wgpu::CommandBuffer peekCommands = peekEncoder.Finish();
      queue.Submit(1, &peekCommands);
      wgpu::Future future = buffer.MapAsync(wgpu::MapMode::Read, 0, 256, wgpu::CallbackMode::WaitAnyOnly,
                                            [](wgpu::MapAsyncStatus, wgpu::StringView) {});
      instance.WaitAny(future, 2'000'000'000ull);
      buffer.Unmap();
    }
    logf("readback x%d: %.2f ms average", kPeeks, ms_since(t0) / kPeeks);
  }

  logf("probe finished");
  post_log(PROBE_VARIANT);
  return 0;
}

int main() {
#if defined(PROBE_CANVAS_TO_THREAD)
  // Same probe on a pthread created with the page canvas transferred to it, the way the GX
  // worker (the web build's only WebGPU thread) would be created.
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  emscripten_pthread_attr_settransferredcanvases(&attr, "#canvas");
  pthread_t thread;
  static int result = 0;
  if (pthread_create(&thread, &attr, [](void*) -> void* { result = run_probe(); return nullptr; }, nullptr) != 0) {
    logf("pthread_create with transferred canvas FAILED");
    post_log(PROBE_VARIANT);
    return 1;
  }
  pthread_join(thread, nullptr);
  return result;
#elif defined(PROBE_IN_STD_THREAD)
  // Same probe on a std::thread instead of the thread that runs main(): the GX worker is one.
  int result = 0;
  std::thread worker([&result] { result = run_probe(); });
  worker.join();
  return result;
#else
  return run_probe();
#endif
}
