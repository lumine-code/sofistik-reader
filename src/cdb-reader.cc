#include <napi.h>

#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <Windows.h>
#endif

namespace {

constexpr int kOpenReadOnly = 95;
constexpr int kMessageOff = 1;
constexpr int kWantReturn = 10;
constexpr int kLockNoWait = 2;
constexpr int kDataEnd = 2;
constexpr int kKeyMissing = 3;
constexpr int kEnquireNext = 1;
constexpr int kEnquireMin = -2;
constexpr int kMaxRecordSize = 1 << 20;
constexpr std::size_t kMaxRecords = 50'000'000;

using PackedCode = std::uint32_t;

#ifdef _WIN32
#define SOFISTIK_CDB_CALL __cdecl
#else
#define SOFISTIK_CDB_CALL
#endif
using InitFunction = int(SOFISTIK_CDB_CALL*)(const char*, int);
using CloseFunction = void(SOFISTIK_CDB_CALL*)(int);
using GetFunction = int(SOFISTIK_CDB_CALL*)(int, int, int, void*, int*, int);
using EnquireFunction = int(SOFISTIK_CDB_CALL*)(int, int*, int*, int);
using MessageLevelFunction = int(SOFISTIK_CDB_CALL*)(int);
using LockHandlingFunction = int(SOFISTIK_CDB_CALL*)(int);
using PackedStringFunction = void(SOFISTIK_CDB_CALL*)(PackedCode*, char*, int);
using RecordVersionFunction = int(SOFISTIK_CDB_CALL*)(int, int, int, int*);
#undef SOFISTIK_CDB_CALL

std::wstring utf8_to_wide(const std::string& value) {
#ifdef _WIN32
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                       static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) throw std::runtime_error("Invalid UTF-8 path supplied to CDB reader.");
  std::wstring result(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                      static_cast<int>(value.size()), result.data(), size);
  return result;
#else
  return std::wstring(value.begin(), value.end());
#endif
}

class CdbReader : public Napi::ObjectWrap<CdbReader> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(env, "CdbReader",
                       {InstanceMethod("read", &CdbReader::Read),
                        InstanceMethod("version", &CdbReader::Version),
                        InstanceMethod("keys", &CdbReader::Keys),
                        InstanceMethod("text", &CdbReader::Text),
                        InstanceMethod("close", &CdbReader::Close)});
  }

  explicit CdbReader(const Napi::CallbackInfo& info) : Napi::ObjectWrap<CdbReader>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
      Napi::TypeError::New(env, "CdbReader requires database and DLL paths.")
          .ThrowAsJavaScriptException();
      return;
    }
    try {
      Open(info[0].As<Napi::String>().Utf8Value(), info[1].As<Napi::String>().Utf8Value());
    } catch (const std::exception& error) {
      CloseNative();
      Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
    }
  }

  ~CdbReader() override { CloseNative(); }

 private:
#ifdef _WIN32
  HMODULE module_ = nullptr;
#endif
  InitFunction init_ = nullptr;
  CloseFunction close_ = nullptr;
  GetFunction get_ = nullptr;
  EnquireFunction enquire_ = nullptr;
  MessageLevelFunction message_level_ = nullptr;
  LockHandlingFunction lock_handling_ = nullptr;
  PackedStringFunction packed_string_ = nullptr;
  RecordVersionFunction record_version_ = nullptr;
  int index_ = 0;
  bool closed_ = true;

  template <typename Function>
  Function LoadFunction(const char* name) {
#ifdef _WIN32
    const auto function = reinterpret_cast<Function>(GetProcAddress(module_, name));
    if (!function) throw std::runtime_error(std::string("CDB DLL does not export ") + name + ".");
    return function;
#else
    static_cast<void>(name);
    return nullptr;
#endif
  }

  template <typename Function>
  Function LoadOptionalFunction(const char* name) {
#ifdef _WIN32
    return reinterpret_cast<Function>(GetProcAddress(module_, name));
#else
    static_cast<void>(name);
    return nullptr;
#endif
  }

  void Open(const std::string& database_path, const std::string& dll_path) {
#ifdef _WIN32
    const std::wstring wide_dll_path = utf8_to_wide(dll_path);
    module_ = LoadLibraryExW(wide_dll_path.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!module_) {
      throw std::runtime_error("Unable to load the configured SOFiSTiK CDB interface DLL (Windows " +
                               std::to_string(GetLastError()) + ").");
    }
    init_ = LoadFunction<InitFunction>("sof_cdb_init");
    close_ = LoadFunction<CloseFunction>("sof_cdb_close");
    get_ = LoadFunction<GetFunction>("sof_cdb_get");
    enquire_ = LoadFunction<EnquireFunction>("sof_cdb_enq");
    message_level_ = LoadFunction<MessageLevelFunction>("sof_cdb_msglevel");
    lock_handling_ = LoadOptionalFunction<LockHandlingFunction>("sof_cdb_setlockhandling");
    if (!lock_handling_) {
      lock_handling_ = LoadOptionalFunction<LockHandlingFunction>(
          "?sof_cdb_setlockhandling@@YAHH@Z");
    }
    packed_string_ = LoadFunction<PackedStringFunction>("sof_lib_ps2cs");
    record_version_ = LoadOptionalFunction<RecordVersionFunction>("sof_cdb_getvers");

    message_level_(kMessageOff);
    message_level_(kWantReturn);
    if (lock_handling_) lock_handling_(kLockNoWait);
    index_ = init_(database_path.c_str(), kOpenReadOnly);
    if (index_ <= 0) {
      throw std::runtime_error("SOFiSTiK could not open the CDB read-only (error " +
                               std::to_string(index_) + ").");
    }
    closed_ = false;
#else
    static_cast<void>(database_path);
    static_cast<void>(dll_path);
    throw std::runtime_error("SOFiSTiK CDB access is available on Windows only.");
#endif
  }

  void EnsureOpen() const {
    if (closed_ || index_ <= 0) throw std::runtime_error("The SOFiSTiK CDB reader is closed.");
  }

  void CloseNative() {
#ifdef _WIN32
    if (!closed_ && close_ && index_ > 0) close_(index_);
    closed_ = true;
    index_ = 0;
    if (module_) FreeLibrary(module_);
    module_ = nullptr;
#else
    closed_ = true;
    index_ = 0;
#endif
  }

  std::vector<int> SecondaryKeys(int primary_key) {
    std::vector<int> result;
    int current_primary = primary_key;
    int current_secondary = 0;
    int status = enquire_(index_, &current_primary, &current_secondary, kEnquireMin);
    std::size_t guard = 0;
    while (status < kDataEnd && current_primary == primary_key && current_secondary != 0 &&
           guard++ < 1000000) {
      result.push_back(current_secondary);
      int next_primary = current_primary;
      int next_secondary = current_secondary;
      status = enquire_(index_, &next_primary, &next_secondary, kEnquireNext);
      if (next_primary == current_primary && next_secondary == current_secondary) break;
      current_primary = next_primary;
      current_secondary = next_secondary;
    }
    return result;
  }

  std::string DecodeText(PackedCode* packed, int capacity) const {
    std::vector<char> text(static_cast<std::size_t>(capacity) + 1, '\0');
    packed_string_(packed, text.data(), capacity);
    std::string result(text.data());
    while (!result.empty() && std::isspace(static_cast<unsigned char>(result.back()))) {
      result.pop_back();
    }
    return result;
  }

  // Reads every record stored under one key into a single buffer, with the
  // length CDB reports for each. The reader has no idea what the bytes mean:
  // record layouts come from the headers of the installation that owns this DLL,
  // so one build serves every release.
  Napi::Value Read(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
      Napi::TypeError::New(env, "read(primaryKey, secondaryKey, maxRecordSize) is required.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    try {
      EnsureOpen();
      const int primary_key = info[0].As<Napi::Number>().Int32Value();
      const int secondary_key = info[1].As<Napi::Number>().Int32Value();
      const int max_size = info[2].As<Napi::Number>().Int32Value();
      if (max_size <= 0 || max_size > kMaxRecordSize) {
        throw std::range_error("The record size is outside the CDB record limits.");
      }
      std::vector<std::uint8_t> record(static_cast<std::size_t>(max_size));
      auto data = std::make_unique<std::vector<std::uint8_t>>();
      std::vector<std::int32_t> lengths;
      int position = 0;
      while (true) {
        int length = max_size;
        std::memset(record.data(), 0, record.size());
        const int result =
            get_(index_, primary_key, secondary_key, record.data(), &length, position);
        if (result >= kDataEnd) break;
        if (length < 0 || length > max_size) {
          throw std::runtime_error("CDB record " + std::to_string(primary_key) + "/" +
                                   std::to_string(secondary_key) + " is " +
                                   std::to_string(length) + " bytes, longer than the " +
                                   std::to_string(max_size) + " bytes this key was read with.");
        }
        data->insert(data->end(), record.begin(), record.begin() + length);
        lengths.push_back(length);
        position = 1;
        if (lengths.size() > kMaxRecords) {
          throw std::runtime_error("The CDB key did not reach an end of data.");
        }
      }

      Napi::Object result = Napi::Object::New(env);
      result.Set("count", Napi::Number::New(env, static_cast<double>(lengths.size())));
      Napi::Int32Array reported = Napi::Int32Array::New(env, lengths.size());
      std::memcpy(reported.Data(), lengths.data(), lengths.size() * sizeof(std::int32_t));
      result.Set("lengths", reported);
      // The buffer has to be V8's own memory: a structured clone - which is how
      // the reply reaches the parent process - refuses an external one, and
      // Electron's V8 enforces that where plain Node does not.
      result.Set("data", Napi::Buffer<std::uint8_t>::Copy(env, data->data(), data->size()));
      return result;
    } catch (const std::exception& error) {
      Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // The version of the records a key actually holds. A database written by an
  // older release stores an older record version than the installed headers
  // describe, and that is the difference between reading a record and reading
  // whatever follows it.
  Napi::Value Version(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
      Napi::TypeError::New(env, "version(primaryKey, secondaryKey) is required.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    try {
      EnsureOpen();
      if (!record_version_) return env.Null();
      int version = 0;
      const int status = record_version_(index_, info[0].As<Napi::Number>().Int32Value(),
                                         info[1].As<Napi::Number>().Int32Value(), &version);
      if (status >= kDataEnd || version <= 0) return env.Null();
      return Napi::Number::New(env, version);
    } catch (const std::exception& error) {
      Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // The secondary keys stored under one primary key — load case numbers, section
  // numbers, material numbers.
  Napi::Value Keys(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
      Napi::TypeError::New(env, "keys(primaryKey) is required.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    try {
      EnsureOpen();
      const std::vector<int> found = SecondaryKeys(info[0].As<Napi::Number>().Int32Value());
      Napi::Int32Array result = Napi::Int32Array::New(env, found.size());
      for (std::size_t index = 0; index < found.size(); ++index) {
        result[index] = found[index];
      }
      return result;
    } catch (const std::exception& error) {
      Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  // Unpacks a run of packed character codes. Each code carries two characters,
  // so a run of n codes decodes to 2n - 1 characters.
  Napi::Value Text(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) {
      Napi::TypeError::New(env, "text(packedCodes) requires a typed array.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    try {
      EnsureOpen();
      Napi::TypedArray codes = info[0].As<Napi::TypedArray>();
      const std::size_t count = codes.ByteLength() / sizeof(PackedCode);
      if (count == 0) return Napi::String::New(env, "");
      const int capacity = static_cast<int>(count) * 2 - 1;
      auto* packed = reinterpret_cast<PackedCode*>(
          static_cast<std::uint8_t*>(codes.ArrayBuffer().Data()) + codes.ByteOffset());
      return Napi::String::New(env, DecodeText(packed, capacity));
    } catch (const std::exception& error) {
      Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    CloseNative();
    return info.Env().Undefined();
  }
};

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("CdbReader", CdbReader::Define(env));
  return exports;
}

}  // namespace

NODE_API_MODULE(sofistik_reader, Initialize)
