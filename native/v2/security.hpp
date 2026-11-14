#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <shellapi.h>
#include <objbase.h>
#include <filesystem>
#include <string>
#include <vector>
#include <stdexcept>
#include <utility>
#include <algorithm>
#include "../../vendor/json.hpp"

namespace aeter {
using Json = nlohmann::json;
namespace fs = std::filesystem;
struct Handle {
    HANDLE h = INVALID_HANDLE_VALUE;
    Handle() = default;
    explicit Handle(HANDLE value) : h(value) {}
    ~Handle() { reset(); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& x) noexcept : h(std::exchange(x.h, INVALID_HANDLE_VALUE)) {}
    Handle& operator=(Handle&& x) noexcept { if (this != &x) { reset(); h = std::exchange(x.h, INVALID_HANDLE_VALUE); } return *this; }
    void reset(HANDLE value = INVALID_HANDLE_VALUE) { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); h = value; }
    explicit operator bool() const { return h && h != INVALID_HANDLE_VALUE; }
};
inline void fail(const char* s) { throw std::runtime_error(s); }
inline std::wstring wide(const std::string& s) {
    if (s.find('\0') != std::string::npos) fail("Invalid text field.");
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (!n && !s.empty()) fail("Invalid UTF-8 text.");
    std::wstring out(n, 0); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), out.data(), n); return out;
}
inline std::string utf8(const std::wstring& s) {
    int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
    if (!n && !s.empty()) fail("Invalid Unicode text.");
    std::string out(n, 0); WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), out.data(), n, nullptr, nullptr); return out;
}
inline std::string hash(const std::string& bytes) {
    BCRYPT_ALG_HANDLE alg{}; BCRYPT_HASH_HANDLE state{};
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) fail("SHA-256 is unavailable.");
    unsigned char digest[32]{};
    bool ok = BCryptCreateHash(alg, &state, nullptr, 0, nullptr, 0, 0) >= 0;
    if (ok) ok = BCryptHashData(state, reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())), static_cast<ULONG>(bytes.size()), 0) >= 0;
    if (ok) ok = BCryptFinishHash(state, digest, sizeof(digest), 0) >= 0;
    if (state) BCryptDestroyHash(state); BCryptCloseAlgorithmProvider(alg, 0);
    if (!ok) fail("SHA-256 failed.");
    std::string out; for (unsigned char c : digest) { out += "0123456789abcdef"[c >> 4]; out += "0123456789abcdef"[c & 15]; } return out;
}
inline std::wstring userSid() {
    Handle token; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.h)) fail("Cannot read current user identity.");
    DWORD size = 0; GetTokenInformation(token.h, TokenUser, nullptr, 0, &size); std::vector<char> bytes(size);
    if (!GetTokenInformation(token.h, TokenUser, bytes.data(), size, &size)) fail("Cannot read current user identity.");
    LPWSTR sid{}; if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &sid)) fail("Cannot read current user identity.");
    std::wstring out(sid); LocalFree(sid); return out;
}
struct Security {
    PSECURITY_DESCRIPTOR sd{};
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, FALSE};
    Security() { auto sddl = L"D:P(A;OICI;GA;;;" + userSid() + L")";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &sd, nullptr)) fail("Cannot protect private files."); sa.lpSecurityDescriptor = sd; }
    ~Security() { LocalFree(sd); }
};
inline fs::path absolutePath(const std::string& text) {
    fs::path p(wide(text)); auto s = p.native();
    if (!p.is_absolute() || s.size() < 3 || s[1] != L':' || s.find(L':', 2) != std::wstring::npos || s.find(L'\0') != std::wstring::npos)
        fail("Use an absolute local path (network paths and streams are unsupported).");
    for (const auto& part : p) if (part == L".." || part == L"." || (!part.empty() && (part.native().back() == L' ' || part.native().back() == L'.'))) fail("Invalid path component.");
    return p.lexically_normal();
}
// Holding directory handles without FILE_SHARE_DELETE prevents ancestor swaps.
inline std::vector<Handle> pinPath(const fs::path& path, bool includeLeaf = false) {
    std::vector<Handle> held; fs::path current = path.root_path();
    auto tail = path.relative_path(); size_t index = 0, count = static_cast<size_t>(std::distance(tail.begin(), tail.end()));
    for (const auto& part : tail) {
        current /= part; ++index; if (!includeLeaf && index == count) break;
        Handle h(CreateFileW(current.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!h) fail("A required directory is missing or inaccessible.");
        BY_HANDLE_FILE_INFORMATION info{};
        if (!GetFileInformationByHandle(h.h, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) fail("Symlink and junction paths are not allowed for native launch.");
        held.push_back(std::move(h));
    } return held;
}
inline void ensurePrivateDir(const fs::path& p) {
    auto pin = pinPath(p); Security security;
    if (!CreateDirectoryW(p.c_str(), &security.sa) && GetLastError() != ERROR_ALREADY_EXISTS) fail("Cannot create native profile directory.");
    auto held = pinPath(p, true);
    if (!SetFileSecurityW(p.c_str(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, security.sd)) fail("Cannot restrict native profile permissions.");
}
inline std::string readFile(const fs::path& p, size_t cap = 8 * 1024 * 1024) {
    auto pin = pinPath(p); Handle h(CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!h) fail("A required file is missing or inaccessible. Prepare the shortcut again in Aeter.");
    BY_HANDLE_FILE_INFORMATION info{}; LARGE_INTEGER size{};
    if (!GetFileInformationByHandle(h.h, &info) || (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || !GetFileSizeEx(h.h, &size) || size.QuadPart < 0 || static_cast<unsigned long long>(size.QuadPart) > cap) fail("Invalid or oversized native launch file.");
    std::string out(static_cast<size_t>(size.QuadPart), 0); DWORD got = 0;
    if (!out.empty() && (!ReadFile(h.h, out.data(), static_cast<DWORD>(out.size()), &got, nullptr) || got != out.size())) fail("Cannot read native launch file.");
    return out;
}
inline void writeFile(const fs::path& p, const std::string& bytes) {
    auto pin = pinPath(p); Security security; GUID guid{}; CoCreateGuid(&guid); wchar_t name[40]{}; StringFromGUID2(guid, name, 40);
    fs::path tmp = p; tmp += name; tmp += L".tmp";
    Handle h(CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, &security.sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!h) fail("Cannot write protected native profile.");
    DWORD written = 0; bool ok = WriteFile(h.h, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size() && FlushFileBuffers(h.h); h.reset();
    if (!ok || !MoveFileExW(tmp.c_str(), p.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) { DeleteFileW(tmp.c_str()); fail("Cannot save protected native profile."); }
}
inline std::string protect(std::string& plain) {
    DATA_BLOB in{static_cast<DWORD>(plain.size()), reinterpret_cast<BYTE*>(plain.data())}, out{};
    if (!CryptProtectData(&in, L"Aeter native V2", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) fail("Windows could not protect launch credentials.");
    std::string bytes(reinterpret_cast<char*>(out.pbData), out.cbData); LocalFree(out.pbData); SecureZeroMemory(plain.data(), plain.size()); return bytes;
}
inline Json unseal(const fs::path& file) {
    auto bytes = readFile(file); DATA_BLOB in{static_cast<DWORD>(bytes.size()), reinterpret_cast<BYTE*>(bytes.data())}, out{};
    if (!CryptUnprotectData(&in, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) fail("Protected profile is damaged or belongs to another Windows user. Prepare the shortcut again.");
    Json json;
    try { json = Json::parse(out.pbData, out.pbData + out.cbData); }
    catch (...) { SecureZeroMemory(out.pbData, out.cbData); LocalFree(out.pbData); fail("Invalid protected launch configuration."); }
    SecureZeroMemory(out.pbData, out.cbData); LocalFree(out.pbData); return json;
}
inline void seal(const fs::path& file, const Json& value) { auto plain = value.dump(); writeFile(file, protect(plain)); }
struct Mutex {
    Handle handle; bool owned = false;
    explicit Mutex(const std::wstring& name, DWORD timeout = 0) { Security security; handle.reset(CreateMutexW(&security.sa, FALSE, name.c_str())); if (!handle) fail("Cannot acquire native launch lock.");
        auto r = WaitForSingleObject(handle.h, timeout); owned = r == WAIT_OBJECT_0 || r == WAIT_ABANDONED; if (!owned) fail("This instance or account is already in use. Try again shortly."); }
    ~Mutex() { if (owned) ReleaseMutex(handle.h); }
};
inline std::wstring mutexName(const std::string& key) { return L"Local\\AeterV2-" + userSid() + L"-" + wide(hash(key)); }
inline std::string stringField(const Json& obj, const char* name, size_t limit = 32768) {
    if (!obj.contains(name) || !obj[name].is_string()) fail("Launch configuration has a missing text field.");
    auto s = obj[name].get<std::string>(); if (s.size() > limit || s.find('\0') != std::string::npos) fail("Launch configuration has an invalid text field."); wide(s); return s;
}
inline std::vector<std::string> strings(const Json& values) {
    if (!values.is_array() || values.size() > 16384) fail("Invalid launch argument list.");
    std::vector<std::string> out; for (const auto& v : values) { if (!v.is_string()) fail("Invalid launch argument."); auto s = v.get<std::string>(); if (s.size() > 1024 * 1024 || s.find('\0') != std::string::npos) fail("Invalid launch argument."); wide(s); out.push_back(s); } return out;
}
inline int64_t nowMs() { FILETIME ft{}; GetSystemTimeAsFileTime(&ft); ULARGE_INTEGER n{}; n.LowPart = ft.dwLowDateTime; n.HighPart = ft.dwHighDateTime; return static_cast<int64_t>(n.QuadPart / 10000 - 11644473600000ULL); }
}
