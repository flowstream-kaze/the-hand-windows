#include <windows.h>
#include <stdio.h>
#include <wchar.h>

#define ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))

static int join_path(wchar_t *out, size_t cap, const wchar_t *left, const wchar_t *right) {
    int written = _snwprintf(out, cap, L"%ls\\%ls", left, right);
    return written >= 0 && (size_t)written < cap;
}

static void show_error(const wchar_t *message) {
    MessageBoxW(NULL, message, L"The Hand for Windows", MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show) {
    (void)instance;
    (void)previous;
    (void)command_line;
    (void)show;

    wchar_t launcher_path[32768];
    DWORD path_length = GetModuleFileNameW(NULL, launcher_path, ARRAY_LEN(launcher_path));
    if (path_length == 0 || path_length >= ARRAY_LEN(launcher_path)) {
        show_error(L"The Hand could not locate its temporary runtime.");
        return 1;
    }

    wchar_t *separator = wcsrchr(launcher_path, L'\\');
    if (!separator) {
        show_error(L"The Hand received an invalid runtime path.");
        return 1;
    }
    *separator = L'\0';
    const wchar_t *base = launcher_path;

    wchar_t node_path[32768];
    wchar_t server_path[32768];
    wchar_t bundled_ytdlp_path[32768];
    wchar_t tools_path[32768];
    if (!join_path(node_path, ARRAY_LEN(node_path), base, L"runtime\\node.exe") ||
        !join_path(server_path, ARRAY_LEN(server_path), base, L"web\\server\\server.mjs") ||
        !join_path(bundled_ytdlp_path, ARRAY_LEN(bundled_ytdlp_path), base, L"tools\\yt-dlp.exe") ||
        !join_path(tools_path, ARRAY_LEN(tools_path), base, L"tools")) {
        show_error(L"The Hand runtime path is too long.");
        return 1;
    }

    wchar_t temp_path[MAX_PATH];
    DWORD temp_length = GetTempPathW(ARRAY_LEN(temp_path), temp_path);
    if (temp_length == 0 || temp_length >= ARRAY_LEN(temp_path)) {
        show_error(L"The Hand could not locate the Windows temporary folder.");
        return 1;
    }

    wchar_t state_path[MAX_PATH * 2];
    wchar_t jobs_path[MAX_PATH * 2];
    wchar_t log_path[MAX_PATH * 2];
    if (!join_path(state_path, ARRAY_LEN(state_path), temp_path, L"TheHandWindows") ||
        !join_path(jobs_path, ARRAY_LEN(jobs_path), state_path, L"jobs") ||
        !join_path(log_path, ARRAY_LEN(log_path), state_path, L"the-hand.log")) {
        show_error(L"The Hand temporary path is too long.");
        return 1;
    }
    CreateDirectoryW(state_path, NULL);
    CreateDirectoryW(jobs_path, NULL);

    wchar_t local_app_data[MAX_PATH * 2];
    DWORD app_data_length = GetEnvironmentVariableW(
        L"LOCALAPPDATA",
        local_app_data,
        ARRAY_LEN(local_app_data)
    );
    if (app_data_length == 0 || app_data_length >= ARRAY_LEN(local_app_data)) {
        show_error(L"The Hand could not locate the local application data folder.");
        return 1;
    }
    wchar_t app_data_path[MAX_PATH * 2];
    wchar_t managed_tools_path[MAX_PATH * 2];
    wchar_t managed_ytdlp_path[MAX_PATH * 2];
    if (!join_path(app_data_path, ARRAY_LEN(app_data_path), local_app_data, L"TheHandWindows") ||
        !join_path(managed_tools_path, ARRAY_LEN(managed_tools_path), app_data_path, L"tools") ||
        !join_path(managed_ytdlp_path, ARRAY_LEN(managed_ytdlp_path), managed_tools_path, L"yt-dlp.exe")) {
        show_error(L"The Hand application data path is too long.");
        return 1;
    }
    CreateDirectoryW(app_data_path, NULL);
    CreateDirectoryW(managed_tools_path, NULL);

    SetEnvironmentVariableW(L"PORTABLE_MODE", L"1");
    SetEnvironmentVariableW(L"HOST", L"127.0.0.1");
    SetEnvironmentVariableW(L"PORT", L"0");
    SetEnvironmentVariableW(L"DATA_DIR", jobs_path);
    SetEnvironmentVariableW(L"BUNDLED_YTDLP_PATH", bundled_ytdlp_path);
    SetEnvironmentVariableW(L"YTDLP_PATH", managed_ytdlp_path);

    DWORD old_path_length = GetEnvironmentVariableW(L"PATH", NULL, 0);
    size_t combined_length = wcslen(tools_path) + (size_t)old_path_length + 2;
    wchar_t *combined_path = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, combined_length * sizeof(wchar_t));
    if (!combined_path) {
        show_error(L"The Hand could not prepare its runtime environment.");
        return 1;
    }
    wcscpy(combined_path, tools_path);
    if (old_path_length > 1) {
        wcscat(combined_path, L";");
        GetEnvironmentVariableW(L"PATH", combined_path + wcslen(combined_path), old_path_length);
    }
    SetEnvironmentVariableW(L"PATH", combined_path);
    HeapFree(GetProcessHeap(), 0, combined_path);

    SECURITY_ATTRIBUTES inherited;
    inherited.nLength = sizeof(inherited);
    inherited.lpSecurityDescriptor = NULL;
    inherited.bInheritHandle = TRUE;
    HANDLE log_file = CreateFileW(
        log_path,
        GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inherited,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );
    HANDLE null_input = CreateFileW(
        L"NUL",
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inherited,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );

    wchar_t process_command[65536];
    int command_length = _snwprintf(
        process_command,
        ARRAY_LEN(process_command),
        L"\"%ls\" \"%ls\"",
        node_path,
        server_path
    );
    if (command_length < 0 || (size_t)command_length >= ARRAY_LEN(process_command)) {
        if (log_file != INVALID_HANDLE_VALUE) CloseHandle(log_file);
        show_error(L"The Hand runtime command is too long.");
        return 1;
    }

    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    if (log_file != INVALID_HANDLE_VALUE) {
        startup.dwFlags |= STARTF_USESTDHANDLES;
        startup.hStdOutput = log_file;
        startup.hStdError = log_file;
        startup.hStdInput = null_input == INVALID_HANDLE_VALUE ? NULL : null_input;
    }

    BOOL started = CreateProcessW(
        node_path,
        process_command,
        NULL,
        NULL,
        TRUE,
        CREATE_NO_WINDOW,
        NULL,
        base,
        &startup,
        &process
    );
    if (null_input != INVALID_HANDLE_VALUE) CloseHandle(null_input);
    if (!started) {
        if (log_file != INVALID_HANDLE_VALUE) CloseHandle(log_file);
        wchar_t message[1024];
        _snwprintf(
            message,
            ARRAY_LEN(message),
            L"The Hand could not start its local server (Windows error %lu).\n\nLog: %ls",
            GetLastError(),
            log_path
        );
        show_error(message);
        return 1;
    }

    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exit_code = 1;
    GetExitCodeProcess(process.hProcess, &exit_code);
    CloseHandle(process.hProcess);
    if (log_file != INVALID_HANDLE_VALUE) CloseHandle(log_file);

    if (exit_code != 0) {
        wchar_t message[1024];
        _snwprintf(
            message,
            ARRAY_LEN(message),
            L"The Hand stopped unexpectedly (exit code %lu).\n\nDetails were written to:\n%ls",
            exit_code,
            log_path
        );
        show_error(message);
    }
    return (int)exit_code;
}
