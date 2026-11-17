#pragma once
#include <windows.h>
#include <sddl.h>
#include <cstdint>
#include <string>
#include <vector>
#include <algorithm>
#include "../../vendor/json.hpp"

namespace aeter {
// the owner is the first live session. Standby runners never send CLEAR for
// another instance. All I/O has a deadline; absence of Discord is non-fatal.
class DiscordRpc {
    HANDLE mutex_ = nullptr;
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
    bool owner_ = false, enabled_ = true, ready_ = false;
    ULONGLONG retry_ = 0, handshakeDeadline_ = 0, partialDeadline_ = 0;
    uint64_t nonce_ = 0;
    const char* status_ = "disabled";
    nlohmann::json activity_;
    std::vector<unsigned char> input_;
    std::wstring testPipe_;
    static constexpr uint32_t maxFrame_ = 65536;

    static std::string text(const nlohmann::json& j, const char* key, const char* fallback = "") {
        const auto found = j.find(key);
        std::string result = found != j.end() && found->is_string() ? found->get<std::string>() : fallback;
        // keep a valid UTF-8 prefix (Discord limits strings to 128 characters).
        size_t end = 0, characters = 0;
        while (end < result.size() && characters < 128) {
            const auto c = static_cast<unsigned char>(result[end]);
            const size_t width = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
            if (end + width > result.size()) break;
            end += width;
            ++characters;
        }
        result.resize(end);
        for (char& c : result) if (static_cast<unsigned char>(c) < 32) c = ' ';
        return result;
    }
    static uint32_t number(const unsigned char* p) {
        return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
    }
    static void appendNumber(std::vector<unsigned char>& b, uint32_t n) {
        for (unsigned i = 0; i < 4; ++i) b.push_back(static_cast<unsigned char>(n >> (i * 8)));
    }
    void disconnect() noexcept {
        if (pipe_ != INVALID_HANDLE_VALUE) { CancelIoEx(pipe_, nullptr); CloseHandle(pipe_); }
        pipe_ = INVALID_HANDLE_VALUE;
        input_.clear(); ready_ = false; partialDeadline_ = 0;
        retry_ = GetTickCount64() + 1000;
    }
    // overlapped operation completion must be collected before its stack frame
    // disappears. Cancellation completion is waited after a short deadline.
    bool transfer(bool write, void* data, DWORD bytes, DWORD& done) {
        done = 0;
        HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!event) return false;
        OVERLAPPED operation{}; operation.hEvent = event;
        BOOL ok = write ? WriteFile(pipe_, data, bytes, &done, &operation)
                        : ReadFile(pipe_, data, bytes, &done, &operation);
        if (!ok && GetLastError() == ERROR_IO_PENDING) {
            if (WaitForSingleObject(event, 25) != WAIT_OBJECT_0) {
                CancelIoEx(pipe_, &operation);
                GetOverlappedResult(pipe_, &operation, &done, TRUE);
                ok = FALSE;
            } else ok = GetOverlappedResult(pipe_, &operation, &done, FALSE);
        }
        CloseHandle(event);
        return ok != FALSE;
    }
    bool send(uint32_t opcode, const nlohmann::json& data) {
        const auto json = data.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
        if (json.size() > maxFrame_) return false;
        std::vector<unsigned char> frame;
        appendNumber(frame, opcode); appendNumber(frame, static_cast<uint32_t>(json.size()));
        frame.insert(frame.end(), json.begin(), json.end());
        DWORD written = 0;
        return transfer(true, frame.data(), static_cast<DWORD>(frame.size()), written) && written == frame.size();
    }
    bool activity(bool clear = false) {
        nlohmann::json args = { {"pid", GetCurrentProcessId()} };
        if (!clear) args["activity"] = activity_;
        else args["activity"] = nullptr;
        return send(1, {{"cmd", "SET_ACTIVITY"}, {"args", args}, {"nonce", std::to_string(++nonce_)}});
    }
    void connect() {
        for (unsigned index = 0; index < (testPipe_.empty() ? 10u : 1u); ++index) {
            const std::wstring name = testPipe_.empty() ? L"\\\\.\\pipe\\discord-ipc-" + std::to_wstring(index) : testPipe_;
            pipe_ = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
            if (pipe_ == INVALID_HANDLE_VALUE) continue;
            if (send(0, {{"v", 1}, {"client_id", "1567886541823545375"}})) {
                status_ = "handshake";
                handshakeDeadline_ = GetTickCount64() + 5000;
                return;
            }
            disconnect();
        }
        status_ = "unavailable";
        retry_ = GetTickCount64() + 1000;
    }
    void receive() {
        DWORD available = 0;
        if (!PeekNamedPipe(pipe_, nullptr, 0, nullptr, &available, nullptr)) { disconnect(); return; }
        if (available) {
            const auto room = static_cast<DWORD>(maxFrame_ + 8 - input_.size());
            if (!room) { disconnect(); return; }
            const auto count = (std::min)(available, room);
            std::vector<unsigned char> bytes(count);
            DWORD read = 0;
            if (!transfer(false, bytes.data(), count, read) || !read) { disconnect(); return; }
            if (input_.empty()) partialDeadline_ = GetTickCount64() + 5000;
            input_.insert(input_.end(), bytes.begin(), bytes.begin() + read);
        }
        while (input_.size() >= 8) {
            const uint32_t op = number(input_.data()), length = number(input_.data() + 4);
            if (op > 4 || length > maxFrame_) { disconnect(); return; }
            if (input_.size() < static_cast<size_t>(8 + length)) break;
            auto data = nlohmann::json::parse(input_.begin() + 8, input_.begin() + 8 + length, nullptr, false);
            input_.erase(input_.begin(), input_.begin() + 8 + length);
            partialDeadline_ = input_.empty() ? 0 : GetTickCount64() + 5000;
            if (data.is_discarded() || op == 2) { disconnect(); return; }
            if (op == 3 && !send(4, data)) { disconnect(); return; }
            if (op == 1 && data.is_object()) {
                const auto event = data.find("evt");
                if (event != data.end() && *event == "READY" && !ready_) {
                    ready_ = true;
                    if (!activity()) { disconnect(); return; }
                    status_ = "sent";
                } else if (event != data.end() && *event == "ERROR") { status_ = "rejected"; disconnect(); return; }
                else if (ready_ && data.value("cmd", "") == "SET_ACTIVITY" && data.value("nonce", "") == std::to_string(nonce_)) status_ = "accepted";
            }
        }
        const auto now = GetTickCount64();
        if ((!ready_ && now >= handshakeDeadline_) || (partialDeadline_ && now >= partialDeadline_)) disconnect();
    }
    void createMutex() {
        HANDLE token = nullptr;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) { enabled_ = false; return; }
        DWORD count = 0;
        GetTokenInformation(token, TokenUser, nullptr, 0, &count);
        std::vector<unsigned char> bytes(count);
        const BOOL ok = GetTokenInformation(token, TokenUser, bytes.data(), count, &count);
        CloseHandle(token);
        if (!ok) { enabled_ = false; return; }
        LPWSTR sid = nullptr;
        if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &sid)) { enabled_ = false; return; }
        std::wstring name = L"Local\\AeterV2.Discord." + std::wstring(sid);
        LocalFree(sid);
#ifdef AETER_NATIVE_TESTING
        // separate arbitration domain per fake server. This non-secret hash is
        // only a mutex-name suffix, not a credential or cryptographic primitive.
        uint64_t suffix = 1469598103934665603ull;
        for (wchar_t c : testPipe_) { suffix ^= static_cast<uint64_t>(c); suffix *= 1099511628211ull; }
        name += L".test." + std::to_wstring(suffix);
#endif
        // use the token's default DACL, including any restrictions from the
        // desktop sandbox. A SID-only DACL refused the second restricted client.
        mutex_ = CreateMutexExW(nullptr, name.c_str(), 0, SYNCHRONIZE | MUTEX_MODIFY_STATE);
        if (!mutex_) { enabled_ = false; status_ = "mutex-unavailable"; }
    }
public:
    DiscordRpc(const nlohmann::json& rpc, int64_t startEpochSeconds) {
        if (!rpc.is_object() || rpc.value("enabled", true) == false) { enabled_ = false; return; }
#ifdef AETER_NATIVE_TESTING
        wchar_t endpoint[256]{};
        const DWORD size = GetEnvironmentVariableW(L"AETER_TEST_DISCORD_PIPE", endpoint, 256);
        const std::wstring prefix = L"\\\\.\\pipe\\AeterV2-test-";
        if (!size || size >= 256 || std::wstring(endpoint).rfind(prefix, 0) != 0) { enabled_ = false; return; }
        testPipe_ = endpoint;
        if (testPipe_.find_first_of(L"\\/", prefix.size()) != std::wstring::npos) { enabled_ = false; return; }
#endif
        activity_ = {{"type", 0}, {"details", text(rpc, "details", "Minecraft")}, {"state", text(rpc, "state")},
            {"timestamps", {{"start", startEpochSeconds}}}, {"instance", false},
            {"assets", {{"large_image", "https://raw.githubusercontent.com/Aeter-MC/Launcher/main/assets/icon.png"},
                        {"large_text", text(rpc, "largeText", "AeterMC")}}}};
        createMutex();
        if (enabled_) status_ = "waiting";
    }
    const char* status() const noexcept { return status_; }
    DiscordRpc(const DiscordRpc&) = delete;
    DiscordRpc& operator=(const DiscordRpc&) = delete;
    ~DiscordRpc() {
        if (owner_ && pipe_ != INVALID_HANDLE_VALUE && ready_) {
            try { activity(true); } catch (...) {}
        }
        disconnect();
        if (owner_) ReleaseMutex(mutex_);
        if (mutex_) CloseHandle(mutex_);
    }
    void tick() noexcept {
        if (!enabled_) return;
        try {
            if (!owner_) {
                const auto status = WaitForSingleObject(mutex_, 0);
                owner_ = status == WAIT_OBJECT_0 || status == WAIT_ABANDONED;
                if (!owner_) return;
            }
            if (pipe_ == INVALID_HANDLE_VALUE) { if (GetTickCount64() >= retry_) connect(); }
            if (pipe_ != INVALID_HANDLE_VALUE) receive();
        } catch (...) { disconnect(); }
    }
};
} // namespace aeter
