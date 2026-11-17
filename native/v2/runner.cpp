// v2 is deliberately separate from the legacy runner. No Electron/Node runtime.
#include "security.hpp"
#include "auth.hpp"
#include "discord.hpp"
#include <thread>
#include <atomic>

namespace aeter {
inline void wipe(Json& j) { if (j.is_string()) { auto& s = j.get_ref<std::string&>(); SecureZeroMemory(s.data(), s.size()); } else if (j.is_structured()) for (auto& child : j) wipe(child); }
struct Wipe { Json& value; ~Wipe() { wipe(value); } };
fs::path exeDir() { std::vector<wchar_t> buffer(32768); DWORD n = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size())); if (!n || n >= buffer.size()) fail("Cannot locate native runtime."); return fs::path(std::wstring(buffer.data(), n)).parent_path(); }
std::wstring quote(const std::string& value) {
    auto input = wide(value); std::wstring out = L"\""; size_t slashes = 0;
    for (wchar_t c : input) { if (c == L'\\') { ++slashes; continue; } out.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\'); out += c; slashes = 0; }
    out.append(slashes * 2, L'\\'); return out + L"\"";
}
void requireTestPath(const fs::path& p) {
#ifdef AETER_NATIVE_TESTING
    wchar_t root[32768]{}; DWORD n = GetEnvironmentVariableW(L"AETER_TEST_ROOT", root, 32768);
    if (!n || n >= 32768) fail("Test binary requires AETER_TEST_ROOT.");
    auto base = absolutePath(utf8(root)).native(), actual = p.native();
    std::transform(base.begin(), base.end(), base.begin(), towlower); std::transform(actual.begin(), actual.end(), actual.begin(), towlower);
    if (actual != base && (actual.size() <= base.size() || actual.substr(0, base.size()) != base || (actual[base.size()] != L'\\' && actual[base.size()] != L'/'))) fail("Test access outside AETER_TEST_ROOT was blocked.");
#else
    (void)p;
#endif
}
void validatePlan(const Json& plan, const std::string& id, bool verify) {
    if (plan.value("schema", 0) != 2 || stringField(plan, "id", 1024) != id) fail("Unsupported or mismatched native plan. Prepare this shortcut again.");
    auto java = absolutePath(stringField(plan, "java")), cwd = absolutePath(stringField(plan,"cwd")); requireTestPath(java); requireTestPath(cwd);
    auto directories = pinPath(cwd, true); auto javaParent = pinPath(java);
    if (!fs::is_regular_file(java) || fs::is_symlink(java)) fail("Java is missing. Select Java in Aeter and refresh this shortcut.");
    auto args = strings(plan.at("jvmArgs")); strings(plan.at("gameArgs"));
    auto main = stringField(plan,"mainClass", 1024);
    if (main.empty() || main.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.$") != std::string::npos) fail("Unsupported Minecraft main class. Prepare this shortcut again.");
    for (const auto& arg : args) if (arg.find("{{AETER_") != std::string::npos || arg == "-jar" || arg == "-m" || arg == "--module" || (!arg.empty() && arg[0] == '@')) fail("Unsupported or secret-bearing JVM argument.");
    stringField(plan,"accountId",1024);
    if (!plan.at("inputs").is_array() || plan["inputs"].size() > 4096 || !plan.at("requiredFiles").is_array() || plan["requiredFiles"].size() > 16384) fail("Invalid native dependency list.");
    for (const auto& input : plan["inputs"]) {
        auto p = absolutePath(stringField(input,"path")); requireTestPath(p);
        auto expected = stringField(input,"sha256",64); if (expected.size() != 64 || expected.find_first_not_of("0123456789abcdef") != std::string::npos) fail("Invalid native dependency fingerprint.");
        if (verify && hash(readFile(p, 64 * 1024 * 1024)) != expected) fail("Instance settings or version files changed. Refresh this shortcut in Aeter.");
    }
    for (const auto& required : plan["requiredFiles"]) {
        if (!required.is_string()) fail("Invalid native dependency path."); auto p = absolutePath(required.get<std::string>()); requireTestPath(p);
        auto pin = pinPath(p, true); if (!fs::is_regular_file(p)) fail("A Minecraft library is missing. Prepare this instance in Aeter.");
    }
    if (!plan.at("rpc").is_object()) fail("Invalid Discord settings.");
}
void validateCredentials(const Json& credentials) {
    auto type = stringField(credentials,"type",32); if (type != "offline" && type != "microsoft") fail("V2 supports offline and Microsoft accounts.");
    for (const auto* key : {"username", "uuid", "xuid", "clientId", "accessToken", "refreshToken"}) stringField(credentials,key, 256 * 1024);
    if (!credentials.contains("expiresAt") || !credentials["expiresAt"].is_number_integer()) fail("Invalid credential expiry.");
}
void normalizeOfflineCredentials(Json& credentials) {
    if (stringField(credentials,"type",32) != "offline") return;
    const auto uuid = offlineUuid(stringField(credentials,"username",256 * 1024));
    credentials["uuid"] = uuid;
    credentials["accessToken"] = uuid;
    credentials["clientId"] = uuid;
    credentials["xuid"] = "0";
    credentials["refreshToken"] = "";
    credentials["expiresAt"] = 0;
}
std::string inputJson() {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE); if (!in || in == INVALID_HANDLE_VALUE || GetFileType(in) != FILE_TYPE_PIPE) fail("Provisioning requires an anonymous input pipe.");
    std::string bytes; char block[8192]; DWORD n = 0;
    while (ReadFile(in, block, sizeof(block), &n, nullptr) && n) { if (bytes.size() + n > 8 * 1024 * 1024) fail("Provisioning input is too large."); bytes.append(block,n); }
    return bytes;
}
void provision(const fs::path& nativeDir, const std::string& id) {
    auto input = inputJson(); Json payload;
    try { payload = Json::parse(input); } catch (...) { SecureZeroMemory(input.data(),input.size()); fail("Invalid provisioning configuration."); }
    SecureZeroMemory(input.data(),input.size()); Wipe guard{payload};
    auto& plan = payload.at("plan"); auto& credentials = payload.at("credentials"); validatePlan(plan,id,true); validateCredentials(credentials); normalizeOfflineCredentials(credentials);
    // reject leaked credentials in JVM arguments even if an exporter is faulty.
    auto jvm = plan.at("jvmArgs").dump();
    for (const auto* key : {"accessToken","refreshToken"}) { auto secret = credentials[key].get<std::string>(); if (secret.size() > 3 && jvm.find(secret) != std::string::npos) fail("Refusing to put credentials in the Java command line."); }
    auto account = hash(stringField(plan,"accountId")); Mutex auth(mutexName(utf8((nativeDir / L"accounts" / (account + ".bin")).native()) + "-auth"), 5000);
    seal(nativeDir / L"accounts" / (account + ".bin"), credentials);
    seal(nativeDir / L"plans" / (hash(id) + ".bin"), plan);
}
std::string substitute(std::string value, const Json& credentials) {
    const std::pair<const char*,const char*> fields[] = {{"{{AETER_ACCESS_TOKEN}}","accessToken"},{"{{AETER_USERNAME}}","username"},{"{{AETER_UUID}}","uuid"},{"{{AETER_XUID}}","xuid"},{"{{AETER_CLIENT_ID}}","clientId"}};
    for (const auto& field : fields) { auto replacement = stringField(credentials,field.second,256*1024); size_t at = 0; while ((at = value.find(field.first, at)) != std::string::npos) { value.replace(at,strlen(field.first),replacement); at += replacement.size(); } }
    if (value.find("{{AETER_") != std::string::npos) fail("Unknown authentication placeholder."); return value;
}
void appendU32(std::string& bytes, uint32_t n) { for (int i = 0; i < 4; ++i) bytes += static_cast<char>((n >> (8*i)) & 255); }
std::string bootstrapPacket(const std::string& main, const std::vector<std::string>& args) { std::string bytes; appendU32(bytes,0x32455441); appendU32(bytes,static_cast<uint32_t>(args.size()+1));
    auto field = [&](const std::string& s){ appendU32(bytes,static_cast<uint32_t>(s.size())); bytes += s; }; field(main); for (const auto& arg : args) field(arg); if (bytes.size() > 4*1024*1024) fail("Game arguments exceed the native limit."); return bytes; }
struct Process {
    Handle job, process, stdinWrite;
};
Process launchJava(const fs::path& java, std::vector<std::string> args, const fs::path& cwd) {
    auto bootstrap = exeDir() / L"aeter-bootstrap.jar"; auto runtimePin = pinPath(bootstrap,true); if (!fs::is_regular_file(bootstrap)) fail("Native bootstrap is missing. Reinstall the experimental runtime.");
    bool cp = false;
    for (size_t i=0;i<args.size();++i) if(args[i]=="-cp" || args[i]=="-classpath" || args[i]=="--class-path") { if (++i >= args.size()) fail("Invalid Java classpath."); args[i] += ";" + utf8(bootstrap.native()); cp=true; }
    if (!cp) { args.push_back("-cp"); args.push_back(utf8(bootstrap.native())); }
    args.push_back("dev.aeter.nativebridge.Main");
    std::wstring command = quote(utf8(java.native())); for (const auto& arg : args) command += L" " + quote(arg);
    if (command.size() >= 32767) fail("Java command line is too long. Shorten library paths.");
    SECURITY_ATTRIBUTES sa{sizeof(sa),nullptr,TRUE}; Handle read,write;
    if (!CreatePipe(&read.h,&write.h,&sa,65536) || !SetHandleInformation(write.h,HANDLE_FLAG_INHERIT,0)) fail("Cannot create private game input.");
    Handle nul(CreateFileW(L"NUL",GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,OPEN_EXISTING,0,nullptr)); if (!nul) fail("Cannot open game output.");
    STARTUPINFOEXW si{}; si.StartupInfo.cb=sizeof(si); si.StartupInfo.dwFlags=STARTF_USESTDHANDLES; si.StartupInfo.hStdInput=read.h; si.StartupInfo.hStdOutput=nul.h; si.StartupInfo.hStdError=nul.h;
    SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr,1,0,&bytes); std::vector<char> attrs(bytes); si.lpAttributeList=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrs.data());
    if (!InitializeProcThreadAttributeList(si.lpAttributeList,1,0,&bytes)) fail("Cannot configure process handle isolation.");
    HANDLE handles[]{read.h,nul.h};
    if (!UpdateProcThreadAttribute(si.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr)) { DeleteProcThreadAttributeList(si.lpAttributeList); fail("Cannot isolate process handles."); }
    Process child; child.job.reset(CreateJobObjectW(nullptr,nullptr)); JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!child.job || !SetInformationJobObject(child.job.h,JobObjectExtendedLimitInformation,&limits,sizeof(limits))) { DeleteProcThreadAttributeList(si.lpAttributeList); fail("Cannot manage game process lifetime."); }
    PROCESS_INFORMATION pi{};
    BOOL ok=CreateProcessW(java.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW|CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT,nullptr,cwd.c_str(),&si.StartupInfo,&pi);
    DeleteProcThreadAttributeList(si.lpAttributeList); if(!ok) fail("Java could not be started. Check its path and installation.");
    child.process.reset(pi.hProcess); Handle thread(pi.hThread);
    if (!AssignProcessToJobObject(child.job.h,child.process.h)) { TerminateProcess(child.process.h,1); WaitForSingleObject(child.process.h,5000); fail("Cannot attach Java to the managed game session."); }
    if (ResumeThread(thread.h)==static_cast<DWORD>(-1)) fail("Cannot resume Java."); child.stdinWrite=std::move(write); return child;
}
void deliver(Process& child, std::string& packet) {
    Handle done(CreateEventW(nullptr,TRUE,FALSE,nullptr)); std::atomic<bool> ok{false};
    std::thread writer([&]{ DWORD n=0; ok=WriteFile(child.stdinWrite.h,packet.data(),static_cast<DWORD>(packet.size()),&n,nullptr) && n==packet.size(); SetEvent(done.h); });
    HANDLE events[]{done.h,child.process.h}; auto wait=WaitForMultipleObjects(2,events,FALSE,10000);
    if(wait!=WAIT_OBJECT_0) CancelSynchronousIo(writer.native_handle()); writer.join(); child.stdinWrite.reset(); SecureZeroMemory(packet.data(),packet.size());
    if(!ok) fail("Java did not accept the private launch handshake.");
}
int runGame(const fs::path& nativeDir,const std::string& id) {
    Mutex instanceLock(mutexName(utf8(nativeDir.native())+"-instance-"+id));
    auto plan=unseal(nativeDir/L"plans"/(hash(id)+".bin")); Wipe planGuard{plan}; validatePlan(plan,id,true);
    auto cwd=absolutePath(stringField(plan,"cwd")); auto cwdPin=pinPath(cwd,true);
    // share the old launch lock as well, avoiding two writers to one game directory.
    auto lockPath=cwd/L".aetermc-launch.lock"; Security security;
    Handle gameLock(CreateFileW(lockPath.c_str(),GENERIC_READ|GENERIC_WRITE|DELETE,FILE_SHARE_READ,&security.sa,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_DELETE_ON_CLOSE,nullptr));
    if(!gameLock) fail("This instance is already running or has a stale Aeter lock. Open Aeter to recover it.");
    auto lockData=Json{{"pid",GetCurrentProcessId()},{"token","native-v2"}}.dump(); DWORD n=0; if(!WriteFile(gameLock.h,lockData.data(),static_cast<DWORD>(lockData.size()),&n,nullptr)) fail("Cannot write game session lock.");
    auto credentials=launchCredentials(nativeDir/L"accounts"/(hash(stringField(plan,"accountId"))+".bin"),nativeDir); Wipe credentialGuard{credentials}; validateCredentials(credentials); normalizeOfflineCredentials(credentials);
    std::vector<std::string> gameArgs; for(auto& s:strings(plan["gameArgs"])) gameArgs.push_back(substitute(s,credentials));
    auto packet=bootstrapPacket(stringField(plan,"mainClass"),gameArgs);
    auto jvmArgs=strings(plan["jvmArgs"]);
    for(const auto* key:{"accessToken","refreshToken"}) { auto secret=credentials[key].get<std::string>(); if(secret.size()>3) for(const auto& s:jvmArgs) if(s.find(secret)!=std::string::npos) fail("Credentials are not allowed in JVM arguments."); }
    auto java=absolutePath(stringField(plan,"java")); auto javaPin=pinPath(java,true);
    auto child=launchJava(java,jvmArgs,cwd); const auto started=nowMs(); deliver(child,packet);
    for(auto& arg:gameArgs) SecureZeroMemory(arg.data(),arg.size()); wipe(credentials);
    DiscordRpc rpc(plan.at("rpc"),started/1000);
    auto session=nativeDir/L"sessions"/(hash(id)+"-"+std::to_string(GetCurrentProcessId())+"-"+std::to_string(started)+".json");
    // logs contain bounded event data only; never raw argv, errors, tokens or child output.
    writeFile(session,Json{{"schema",2},{"event","java-started"},{"runnerPid",GetCurrentProcessId()},{"javaPid",GetProcessId(child.process.h)},{"start",started}}.dump());
    while(WaitForSingleObject(child.process.h,100)!=WAIT_OBJECT_0) rpc.tick();
    DWORD code=1; if(!GetExitCodeProcess(child.process.h,&code)) fail("Cannot read Java exit status.");
    writeFile(session,Json{{"schema",2},{"event","java-exited"},{"runnerPid",GetCurrentProcessId()},{"javaPid",GetProcessId(child.process.h)},{"start",started},{"durationMs",nowMs()-started},{"exitCode",code},{"discord",rpc.status()}}.dump());
    if(code!=0) fail("Minecraft exited with an error. Check the instance's Minecraft logs."); return 0;
}
int run(const std::vector<std::wstring>& argv) {
    bool provisioning=false; std::string profile,id; bool sawProfile=false,sawId=false;
    for(size_t i=1;i<argv.size();++i) { auto arg=argv[i]; if(arg==L"--provision" && !provisioning) { provisioning=true; continue; }
        if(i+1>=argv.size()) fail("Missing native launcher argument.");
        if(arg==L"--profile" && !sawProfile) { profile=utf8(argv[++i]); sawProfile=true; }
        else if(arg==L"--instance" && !sawId) { id=utf8(argv[++i]); sawId=true; }
        else fail("Unknown or repeated native launcher argument."); }
    if(!sawProfile||!sawId||id.empty()||id.size()>1024) fail("Use --profile and --instance with a prepared shortcut.");
    auto root=absolutePath(profile); requireTestPath(root); auto pin=pinPath(root,true);
    auto nativeDir=root/L"native-v2"; ensurePrivateDir(nativeDir);
    for(const auto* dir:{L"plans",L"accounts",L"sessions"}) ensurePrivateDir(nativeDir/dir);
    auto nativePin=pinPath(nativeDir,true);
    if(provisioning) { Mutex lock(mutexName(utf8(nativeDir.native())+"-instance-"+id)); provision(nativeDir,id); return 0; }
    return runGame(nativeDir,id);
}
void report(const char* error) { std::string message=std::string("Aeter V2: ")+error+"\n"; HANDLE err=GetStdHandle(STD_ERROR_HANDLE); if(err && err!=INVALID_HANDLE_VALUE && GetFileType(err)==FILE_TYPE_PIPE) { DWORD n=0; WriteFile(err,message.data(),static_cast<DWORD>(message.size()),&n,nullptr); } else MessageBoxW(nullptr,wide(message).c_str(),L"Aeter Native V2",MB_OK|MB_ICONERROR); }
}
int WINAPI wWinMain(HINSTANCE,HINSTANCE,PWSTR,int) {
    SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32|LOAD_LIBRARY_SEARCH_APPLICATION_DIR); SetDllDirectoryW(L"");
    try { int argc=0; auto raw=CommandLineToArgvW(GetCommandLineW(),&argc); if(!raw) aeter::fail("Cannot read launcher arguments."); std::vector<std::wstring> args(raw,raw+argc); LocalFree(raw); return aeter::run(args); }
    catch(const nlohmann::json::exception&) { aeter::report("Invalid launch configuration. Prepare the shortcut again in Aeter."); }
    catch(const std::filesystem::filesystem_error&) { aeter::report("A required file is missing or inaccessible. Prepare the shortcut again in Aeter."); }
    catch(const std::exception& e) { aeter::report(e.what()); }
    return 1;
}
