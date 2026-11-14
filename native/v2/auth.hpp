#pragma once
#include "security.hpp"
#include <winhttp.h>
namespace aeter {
struct HttpHandle { HINTERNET h{}; explicit HttpHandle(HINTERNET x) : h(x) {} ~HttpHandle() { if(h) WinHttpCloseHandle(h); } };
inline std::string formEscape(const std::string& value) { std::string out; for (unsigned char c : value) { if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') out += c; else { out += '%'; out += "0123456789ABCDEF"[c >> 4]; out += "0123456789ABCDEF"[c & 15]; } } return out; }
inline Json http(const wchar_t* host, const wchar_t* route, const std::string& body, bool form = false, const std::string& bearer = "") {
#ifdef AETER_NATIVE_TESTING
    (void)host; (void)route; (void)body; (void)form; (void)bearer;
    fail("Network authentication is disabled in the native test binary."); return {};
#else
    HttpHandle session(WinHttpOpen(L"AeterNative/2", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session.h) fail("Cannot contact Microsoft. Check your connection and sign in again in Aeter.");
    WinHttpSetTimeouts(session.h, 10000, 10000, 15000, 15000);
    HttpHandle connection(WinHttpConnect(session.h, host, INTERNET_DEFAULT_HTTPS_PORT, 0));
    HttpHandle request(connection.h ? WinHttpOpenRequest(connection.h, bearer.empty() ? L"POST" : L"GET", route, nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE) : nullptr);
    if (!request.h) fail("Cannot create Microsoft HTTPS request.");
    DWORD disabled = WINHTTP_DISABLE_REDIRECTS; WinHttpSetOption(request.h, WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled));
    std::wstring headers = form ? L"Content-Type: application/x-www-form-urlencoded\r\n" : L"Content-Type: application/json\r\n";
    if (!bearer.empty()) headers += L"Authorization: Bearer " + wide(bearer) + L"\r\n";
    if (!WinHttpSendRequest(request.h, headers.c_str(), static_cast<DWORD>(headers.size()), body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()), static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0) || !WinHttpReceiveResponse(request.h, nullptr)) fail("Microsoft login could not be refreshed. Check your connection or sign in again in Aeter.");
    DWORD status = 0, length = sizeof(status); if (!WinHttpQueryHeaders(request.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &length, WINHTTP_NO_HEADER_INDEX) || status != 200) fail("Microsoft rejected the saved login. Sign in again in Aeter and refresh this shortcut.");
    std::string data; char buffer[8192]; DWORD count = 0;
    while (WinHttpReadData(request.h, buffer, sizeof(buffer), &count) && count) { if (data.size() + count > 1024 * 1024) fail("Invalid authentication response."); data.append(buffer, count); }
    try { auto result = Json::parse(data); SecureZeroMemory(data.data(), data.size()); return result; } catch (...) { SecureZeroMemory(data.data(), data.size()); fail("Invalid authentication response."); return {}; }
#endif
}
inline Json refreshMicrosoft(Json credentials) {
    auto refresh = stringField(credentials, "refreshToken"); if (refresh.empty()) fail("Microsoft session expired. Sign in again in Aeter and refresh this shortcut.");
    auto ms = http(L"login.live.com", L"/oauth20_token.srf", "client_id=00000000402b5328&scope=service%3A%3Auser.auth.xboxlive.com%3A%3AMBI_SSL&grant_type=refresh_token&refresh_token=" + formEscape(refresh), true);
    Json xbl;
    for (const auto* prefix : {"d=", "t="}) {
        try { xbl = http(L"user.auth.xboxlive.com", L"/user/authenticate", Json{{"Properties", {{"AuthMethod", "RPS"}, {"SiteName", "user.auth.xboxlive.com"}, {"RpsTicket", std::string(prefix) + stringField(ms,"access_token")}}}, {"RelyingParty", "http://auth.xboxlive.com"}, {"TokenType", "JWT"}}.dump()); break; }
        catch (...) { if (std::string(prefix) == "t=") throw; }
    }
    auto uhs = xbl.at("DisplayClaims").at("xui").at(0).at("uhs").get<std::string>();
    auto xsts = http(L"xsts.auth.xboxlive.com", L"/xsts/authorize", Json{{"Properties", {{"SandboxId", "RETAIL"}, {"UserTokens", Json::array({stringField(xbl,"Token")})}}}, {"RelyingParty", "rp://api.minecraftservices.com/"}, {"TokenType", "JWT"}}.dump());
    auto mc = http(L"api.minecraftservices.com", L"/authentication/login_with_xbox", Json{{"identityToken", "XBL3.0 x=" + uhs + ";" + stringField(xsts,"Token")}}.dump());
    auto token = stringField(mc,"access_token"); auto profile = http(L"api.minecraftservices.com", L"/minecraft/profile", "", false, token);
    if (stringField(profile,"id") != stringField(credentials,"uuid")) fail("The saved Microsoft account changed. Refresh this shortcut in Aeter.");
    credentials["accessToken"] = token;
    credentials["refreshToken"] = ms.value("refresh_token", refresh);
    credentials["expiresAt"] = nowMs() + std::clamp<int64_t>(mc.value("expires_in", int64_t(3600)), 1, 86400) * 1000;
    credentials["username"] = stringField(profile,"name");
    const auto& claims = xsts.at("DisplayClaims").at("xui").at(0);
    if (claims.contains("xid")) credentials["xuid"] = claims["xid"];
    return credentials;
}
inline Json launchCredentials(const fs::path& store, const fs::path& nativeDir) {
    Mutex lock(mutexName(utf8(store.native()) + "-auth"), 120000); auto credentials = unseal(store);
    auto type = stringField(credentials, "type", 32);
    if (type == "offline") return credentials;
    if (type != "microsoft") fail("This account type requires Aeter. V2 supports offline and Microsoft accounts.");
    if (credentials.value("expiresAt", int64_t(0)) < nowMs() + 300000) {
#ifdef AETER_NATIVE_TESTING
        wchar_t mode[16]{}; GetEnvironmentVariableW(L"AETER_TEST_AUTH", mode, 16);
        if (std::wstring(mode) != L"fixture") fail("Microsoft session expired. Refresh this shortcut in Aeter.");
        auto updated = Json::parse(readFile(nativeDir / L"test-auth-response.json"));
        if (updated.value("uuid", "") != credentials.value("uuid", "") || updated.value("expiresAt", int64_t(0)) < nowMs() + 300000) fail("Invalid mock authentication response.");
        credentials = updated;
#else
        (void)nativeDir;
        try { credentials = refreshMicrosoft(credentials); } catch (const nlohmann::json::exception&) { fail("Microsoft returned an invalid response. Sign in again in Aeter."); }
#endif
        seal(store, credentials);
    }
    return credentials;
}
}
