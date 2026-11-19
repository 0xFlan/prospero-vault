// Prospero Vault: native PS5 title.
//
// Draws the library with VideoOut, reads the DualSense directly, and talks to
// the existing Prospero Vault payload on 127.0.0.1:8097 for the library and
// the install/launch actions. Built as a development FSELF with the clean-room
// runtime companion.

#include "render.hpp"

#include <cstddef>
#include <cstdint>

// ---------------------------------------------------------------------------
// Platform entry points
// ---------------------------------------------------------------------------

extern "C"
{
    int sceKernelUsleep(unsigned int microseconds);
    int sceKernelDebugOutText(int channel, const char *text);
    int sceNetInit();
    int sceNetSocket(const char *name, int domain, int type, int protocol);
    int sceNetConnect(int socket, const void *address, unsigned int length);
    int sceNetSend(int socket, const void *buffer, unsigned long length, int flags);
    int sceNetRecv(int socket, void *buffer, unsigned long length, int flags);
    int sceNetSocketClose(int socket);
    int sceNetSetsockopt(int socket, int level, int option, const void *value,
                         unsigned int length);
    int sceNetBind(int socket, const void *address, unsigned int length);
    int sceNetListen(int socket, int backlog);
    int sceNetAccept(int socket, void *address, unsigned int *length);
    int sceUserServiceInitialize(void *param);
    int sceUserServiceGetInitialUser(int *user);
    int scePadInit();
    int scePadOpen(int user_id, int type, int index, void *param);
    int scePadReadState(int handle, void *data);
}

namespace
{
// ---------------------------------------------------------------------------
// Small freestanding helpers: the loader shim is not a full libc.
// ---------------------------------------------------------------------------

struct SockAddrIn
{
    unsigned char length;
    unsigned char family;
    unsigned short port;
    unsigned int address;
    unsigned char zero[8];
};

constexpr int kAfInet = 2;
constexpr int kSockStream = 1;
constexpr int kSolSocket = 0xffff;
constexpr int kSoReuse = 0x0004;
constexpr int kSoNonBlocking = 0x1200;
constexpr int kBackendPort = 8097;
constexpr int kStatusPort = 8096;

struct PadData
{
    unsigned int buttons;
    struct
    {
        unsigned char x;
        unsigned char y;
    } left_stick;
    struct
    {
        unsigned char x;
        unsigned char y;
    } right_stick;
    struct
    {
        unsigned char l2;
        unsigned char r2;
    } analog;
    unsigned short padding;
    float quat[4];
    float velocity[3];
    float acceleration[3];
    unsigned char touch[32];
    unsigned char connected;
    unsigned long long timestamp;
    unsigned char extension[16];
    unsigned char count;
    unsigned char unknown[15];
};

constexpr unsigned kPadUp = 0x0010;
constexpr unsigned kPadDown = 0x0040;
constexpr unsigned kPadCross = 0x4000;
constexpr unsigned kPadCircle = 0x2000;
constexpr unsigned kPadSquare = 0x8000;
constexpr unsigned kPadTriangle = 0x1000;
constexpr unsigned kPadL1 = 0x0400;
constexpr unsigned kPadR1 = 0x0800;
constexpr unsigned kPadOptions = 0x0008;

unsigned text_length(const char *text)
{
    unsigned length = 0;
    while (text && text[length])
    {
        ++length;
    }
    return length;
}

void copy_text(char *destination, int capacity, const char *source)
{
    int index = 0;
    if (capacity <= 0)
    {
        return;
    }
    while (source && source[index] && index < capacity - 1)
    {
        destination[index] = source[index];
        ++index;
    }
    destination[index] = '\0';
}

const char *find_text(const char *start, const char *limit, const char *needle)
{
    if (!start || !needle || !needle[0])
    {
        return nullptr;
    }
    const unsigned needle_length = text_length(needle);
    for (const char *at = start; at + needle_length <= limit; ++at)
    {
        unsigned index = 0;
        while (index < needle_length && at[index] == needle[index])
        {
            ++index;
        }
        if (index == needle_length)
        {
            return at;
        }
    }
    return nullptr;
}

char *append_text(char *at, char *limit, const char *text)
{
    while (text && *text && at < limit - 1)
    {
        *at++ = *text++;
    }
    *at = '\0';
    return at;
}

char *append_uint(char *at, char *limit, unsigned long long value)
{
    char digits[24];
    int count = 0;
    if (value == 0)
    {
        digits[count++] = '0';
    }
    while (value > 0 && count < 24)
    {
        digits[count++] = static_cast<char>('0' + (value % 10));
        value /= 10;
    }
    while (count > 0 && at < limit - 1)
    {
        *at++ = digits[--count];
    }
    *at = '\0';
    return at;
}

void format_size(char *out, int capacity, const char *digits)
{
    unsigned long long value = 0;
    while (digits && *digits >= '0' && *digits <= '9')
    {
        value = value * 10 + static_cast<unsigned long long>(*digits - '0');
        ++digits;
    }
    char *at = out;
    char *limit = out + capacity;
    const unsigned long long gigabyte = 1024ull * 1024ull * 1024ull;
    if (value >= gigabyte)
    {
        const unsigned long long hundredths = value / (gigabyte / 100ull);
        at = append_uint(at, limit, hundredths / 100ull);
        at = append_text(at, limit, ".");
        at = append_uint(at, limit, hundredths % 100ull);
        append_text(at, limit, " GB");
    }
    else
    {
        const unsigned long long megabytes = value / (1024ull * 1024ull);
        at = append_uint(at, limit, megabytes);
        append_text(at, limit, " MB");
    }
}

void format_uint(char *out, int capacity, unsigned long long value)
{
    char *limit = out + capacity;
    append_uint(out, limit, value);
}

void uppercase(char *destination, int capacity, const char *source)
{
    int index = 0;
    if (capacity <= 0)
    {
        return;
    }
    while (source && source[index] && index < capacity - 1)
    {
        char character = source[index];
        if (character >= 'a' && character <= 'z')
        {
            character = static_cast<char>(character - 'a' + 'A');
        }
        if (character < ' ' || character > '~')
        {
            character = ' ';
        }
        destination[index] = character;
        ++index;
    }
    destination[index] = '\0';
}

void log_text(const char *text)
{
    sceKernelDebugOutText(0, text);
}

unsigned short network_port(int port)
{
    return static_cast<unsigned short>(((port & 0xff) << 8) | ((port >> 8) & 0xff));
}

int open_socket(int port, bool listener)
{
    const int descriptor = sceNetSocket("prospero-vault", kAfInet, kSockStream, 0);
    if (descriptor < 0)
    {
        return -1;
    }
    const int reuse = 1;
    sceNetSetsockopt(descriptor, kSolSocket, kSoReuse, &reuse, sizeof reuse);

    SockAddrIn address{};
    address.length = sizeof address;
    address.family = kAfInet;
    address.port = network_port(port);
    address.address = listener ? 0u : 0x0100007fu; // 127.0.0.1

    if (listener)
    {
        if (sceNetBind(descriptor, &address, sizeof address) != 0 ||
            sceNetListen(descriptor, 4) != 0)
        {
            sceNetSocketClose(descriptor);
            return -1;
        }
    }
    else if (sceNetConnect(descriptor, &address, sizeof address) != 0)
    {
        sceNetSocketClose(descriptor);
        return -1;
    }
    return descriptor;
}

bool send_all(int descriptor, const char *data, int length)
{
    int sent = 0;
    while (sent < length)
    {
        const int written = sceNetSend(descriptor, data + sent,
                                       static_cast<unsigned long>(length - sent), 0);
        if (written <= 0)
        {
            return false;
        }
        sent += written;
    }
    return true;
}

void set_nonblocking(int descriptor)
{
    const int enabled = 1;
    sceNetSetsockopt(descriptor, kSolSocket, kSoNonBlocking, &enabled, sizeof enabled);
}

int http_request(int port, const char *method, const char *path, const char *body, char *response,
                 int capacity)
{
    char request[768];
    char *limit = request + sizeof request;
    char *at = request;
    at = append_text(at, limit, method);
    at = append_text(at, limit, " ");
    at = append_text(at, limit, path);
    at = append_text(at, limit, " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if (body)
    {
        at = append_text(at, limit, "Content-Type: application/json\r\nContent-Length: ");
        at = append_uint(at, limit, text_length(body));
        at = append_text(at, limit, "\r\n\r\n");
        at = append_text(at, limit, body);
    }
    else
    {
        at = append_text(at, limit, "\r\n");
    }

    const int socket = open_socket(port, false);
    if (socket < 0)
    {
        return -1;
    }
    const bool sent = send_all(socket, request, static_cast<int>(at - request));
    set_nonblocking(socket);

    char incoming[16384];
    int used = 0;
    unsigned idle_ms = 0;
    while (sent && used < static_cast<int>(sizeof incoming) - 1 && idle_ms < 2500)
    {
        const int got = sceNetRecv(socket, incoming + used,
                                   static_cast<unsigned long>(sizeof incoming - 1 - used), 0);
        if (got > 0)
        {
            used += got;
            idle_ms = 0;
        }
        else if (got == 0)
        {
            break;
        }
        else
        {
            sceKernelUsleep(2000);
            idle_ms += 2;
        }
    }
    sceNetSocketClose(socket);
    if (!sent || used <= 0)
    {
        return -1;
    }

    incoming[used] = '\0';
    int body_at = -1;
    for (int index = 0; index + 3 < used; ++index)
    {
        if (incoming[index] == '\r' && incoming[index + 1] == '\n' &&
            incoming[index + 2] == '\r' && incoming[index + 3] == '\n')
        {
            body_at = index + 4;
            break;
        }
    }
    if (body_at < 0)
    {
        return -1;
    }
    int length = used - body_at;
    if (length > capacity - 1)
    {
        length = capacity - 1;
    }
    for (int index = 0; index < length; ++index)
    {
        response[index] = incoming[body_at + index];
    }
    response[length] = '\0';
    return length;
}

// ---------------------------------------------------------------------------
// Library state and JSON reading
// ---------------------------------------------------------------------------

struct Game
{
    char id[24];
    char name[128];
    char kind[8];
    char platform[8];
    char size_digits[24];
    char size_label[24];
    bool installed;
    bool pkg;
};

struct State
{
    Game games[48];
    int count;
    bool backend;
    bool scanning;
    bool playing;
    int selected;
    int scroll;
    unsigned frames;
    char status[96];
};

State g_state{};
int g_backend_port = kBackendPort;

bool read_string(const char *start, const char *limit, const char *key, char *out, int capacity)
{
    const char *at = find_text(start, limit, key);
    if (!at)
    {
        return false;
    }
    at += text_length(key);
    int index = 0;
    while (at < limit && *at && *at != '"' && index < capacity - 1)
    {
        if (*at == '\\' && at + 1 < limit)
        {
            ++at;
        }
        out[index++] = *at++;
    }
    out[index] = '\0';
    return true;
}

bool read_bool(const char *start, const char *limit, const char *key)
{
    const char *at = find_text(start, limit, key);
    return at && at + text_length(key) + 4 <= limit &&
           at[text_length(key)] == 't' && at[text_length(key) + 1] == 'r';
}

void parse_games(const char *body, int length)
{
    const char *limit = body + length;
    g_state.count = 0;
    g_state.backend = true;

    const char *games = find_text(body, limit, "\"games\":[");
    if (!games)
    {
        copy_text(g_state.status, sizeof g_state.status, "Backend answered without a library");
        return;
    }
    g_state.scanning = read_bool(body, limit, "\"scanning\":");
    g_state.playing = read_bool(body, limit, "\"playing\":");

    const char *at = games;
    while (g_state.count < 48 && at < limit)
    {
        const char *open = find_text(at, limit, "{");
        if (!open)
        {
            break;
        }
        const char *close = find_text(open, limit, "}");
        if (!close)
        {
            break;
        }

        Game &game = g_state.games[g_state.count];
        game.id[0] = '\0';
        game.name[0] = '\0';
        game.kind[0] = '\0';
        game.platform[0] = '\0';
        game.size_digits[0] = '\0';
        game.size_label[0] = '\0';
        game.installed = read_bool(open, close, "\"installed\":");
        game.pkg = read_bool(open, close, "\"pkg\":");

        const bool complete =
            read_string(open, close, "\"id\":\"", game.id, sizeof game.id) &&
            read_string(open, close, "\"name\":\"", game.name, sizeof game.name);
        read_string(open, close, "\"kind\":\"", game.kind, sizeof game.kind);
        read_string(open, close, "\"platform\":\"", game.platform, sizeof game.platform);
        if (read_string(open, close, "\"size\":\"", game.size_digits, sizeof game.size_digits))
        {
            format_size(game.size_label, sizeof game.size_label, game.size_digits);
        }

        if (complete)
        {
            ++g_state.count;
        }
        at = close + 1;
        if (find_text(at, limit, "]") == at + 1 || *at == ']')
        {
            break;
        }
    }

    if (g_state.selected >= g_state.count)
    {
        g_state.selected = g_state.count > 0 ? g_state.count - 1 : 0;
    }
    if (g_state.selected < 0)
    {
        g_state.selected = 0;
    }
}

void fetch_library()
{
    static char response[16384];
    int length = -1;
    const int ports[2] = {kBackendPort, 8098};
    for (int attempt = 0; attempt < 2 && length < 0; ++attempt)
    {
        length = http_request(ports[attempt], "GET", "/api/games", nullptr, response,
                              sizeof response);
        if (length >= 0)
        {
            g_backend_port = ports[attempt];
        }
    }
    if (length < 0)
    {
        g_state.backend = false;
        g_state.count = 0;
        g_state.scanning = false;
        g_state.playing = false;
        copy_text(g_state.status, sizeof g_state.status,
                  "Backend offline. Load prospero-vault.elf with elfldr on port 9021.");
        log_text("vault-native: backend offline\n");
        return;
    }
    parse_games(response, length);

    char line[128];
    char *at = line;
    char *limit = line + sizeof line;
    at = append_text(at, limit, "vault-native: library ");
    at = append_uint(at, limit, static_cast<unsigned>(g_state.count));
    at = append_text(at, limit, g_state.scanning ? " scanning\n" : " ready\n");
    log_text(line);
}

bool post_action(const char *path, const char *body)
{
    static char response[2048];
    const int length =
        http_request(g_backend_port, "POST", path, body, response, sizeof response);
    if (length < 0)
    {
        return false;
    }
    return find_text(response, response + length, "\"ok\":true") != nullptr;
}

void play_selected()
{
    if (g_state.count == 0)
    {
        copy_text(g_state.status, sizeof g_state.status, "Nothing to play");
        return;
    }
    const Game &game = g_state.games[g_state.selected];
    char body[96];
    char *limit = body + sizeof body;
    char *at = body;
    at = append_text(at, limit, "{\"id\":\"");
    at = append_text(at, limit, game.id);
    at = append_text(at, limit, "\"}");

    const bool ok = post_action("/api/play", body);
    if (ok)
    {
        char message[96];
        char *m = message;
        char *end = message + sizeof message;
        m = append_text(m, end, "Launching ");
        m = append_text(m, end, game.name);
        copy_text(g_state.status, sizeof g_state.status, message);
        log_text("vault-native: play requested\n");
    }
    else
    {
        copy_text(g_state.status, sizeof g_state.status,
                  "Launch refused. Is the title installed and the payload running?");
        log_text("vault-native: play refused\n");
    }
}

void scan_library()
{
    copy_text(g_state.status, sizeof g_state.status, "Scanning the console's library...");
    post_action("/api/scan", "{}");
    sceKernelUsleep(900000);
    fetch_library();
    if (g_state.backend)
    {
        copy_text(g_state.status, sizeof g_state.status, "Library refreshed");
    }
}

// ---------------------------------------------------------------------------
// Status endpoint: proves the frame loop and reports what the title sees.
// ---------------------------------------------------------------------------

int g_status_socket = -1;

void status_start()
{
    g_status_socket = open_socket(kStatusPort, true);
    if (g_status_socket >= 0)
    {
        set_nonblocking(g_status_socket);
        log_text("vault-native: status listener on 8096\n");
    }
}

void status_poll()
{
    if (g_status_socket < 0)
    {
        return;
    }
    for (;;)
    {
        unsigned int length = 0;
        const int client = sceNetAccept(g_status_socket, nullptr, &length);
        if (client < 0)
        {
            return;
        }
        char request[256];
        (void)sceNetRecv(client, request, sizeof request - 1, 0);

        char response[512];
        char *limit = response + sizeof response;
        char *at = response;
        at = append_text(at, limit, "{\"ok\":true,\"app\":\"prospero-vault\",\"native\":true,\"frames\":");
        at = append_uint(at, limit, g_state.frames);
        at = append_text(at, limit, ",\"games\":");
        at = append_uint(at, limit, static_cast<unsigned>(g_state.count));
        at = append_text(at, limit, ",\"backend\":");
        at = append_text(at, limit, g_state.backend ? "true" : "false");
        at = append_text(at, limit, ",\"selected\":\"");
        if (g_state.count > 0)
        {
            at = append_text(at, limit, g_state.games[g_state.selected].id);
        }
        at = append_text(at, limit, "\"}\n");
        const int body_length = static_cast<int>(at - response);

        char header[192];
        char *h = header;
        char *hend = header + sizeof header;
        h = append_text(h, hend, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ");
        h = append_uint(h, hend, static_cast<unsigned long long>(body_length));
        h = append_text(h, hend, "\r\nConnection: close\r\n\r\n");
        send_all(client, header, static_cast<int>(h - header));
        send_all(client, response, body_length);
        sceNetSocketClose(client);
    }
}

// ---------------------------------------------------------------------------
// Controller and actions
// ---------------------------------------------------------------------------

int g_pad = -1;
unsigned g_last_buttons = 0;

void pad_tick()
{
    if (g_pad < 0)
    {
        int user = -1;
        if (sceUserServiceGetInitialUser(&user) == 0)
        {
            g_pad = scePadOpen(user, 0, 0, nullptr);
        }
        if (g_pad < 0)
        {
            return;
        }
    }

    PadData data{};
    if (scePadReadState(g_pad, &data) != 0 || !data.connected)
    {
        g_last_buttons = 0;
        return;
    }

    const unsigned pressed = data.buttons & ~g_last_buttons;
    g_last_buttons = data.buttons;
    if (!pressed)
    {
        return;
    }

    if (pressed & kPadDown)
    {
        if (g_state.count > 0)
        {
            g_state.selected = (g_state.selected + 1) % g_state.count;
        }
    }
    if (pressed & kPadUp)
    {
        if (g_state.count > 0)
        {
            g_state.selected = (g_state.selected + g_state.count - 1) % g_state.count;
        }
    }
    if (pressed & kPadR1)
    {
        g_state.selected += 10;
    }
    if (pressed & kPadL1)
    {
        g_state.selected -= 10;
    }
    if (pressed & (kPadL1 | kPadR1))
    {
        if (g_state.count > 0)
        {
            while (g_state.selected < 0)
            {
                g_state.selected += g_state.count;
            }
            g_state.selected %= g_state.count;
        }
        else
        {
            g_state.selected = 0;
        }
    }
    if (g_state.selected < g_state.scroll)
    {
        g_state.scroll = g_state.selected;
    }
    if (g_state.selected >= g_state.scroll + 10)
    {
        g_state.scroll = g_state.selected - 9;
    }

    if (pressed & kPadCross)
    {
        play_selected();
    }
    if (pressed & kPadSquare)
    {
        scan_library();
    }
    if (pressed & (kPadTriangle | kPadOptions))
    {
        copy_text(g_state.status, sizeof g_state.status, "Reloading the library...");
        fetch_library();
    }
    if (pressed & kPadCircle)
    {
        copy_text(g_state.status, sizeof g_state.status, "Use the PS button to close Prospero Vault.");
    }
}

void tick()
{
    ++g_state.frames;
    status_poll();
    pad_tick();

    // A quiet periodic refresh keeps the list current without a worker thread.
    if (g_state.frames % 600 == 0)
    {
        fetch_library();
    }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const std::uint32_t kBackground = vault::rgb(10, 14, 24);
const std::uint32_t kPanel = vault::rgb(21, 28, 43);
const std::uint32_t kPanelRaised = vault::rgb(32, 41, 60);
const std::uint32_t kLine = vault::rgb(52, 64, 88);
const std::uint32_t kAccent = vault::rgb(232, 180, 90);
const std::uint32_t kTeal = vault::rgb(92, 200, 190);
const std::uint32_t kText = vault::rgb(233, 237, 245);
const std::uint32_t kDim = vault::rgb(132, 145, 168);
const std::uint32_t kGreen = vault::rgb(112, 200, 142);
const std::uint32_t kRed = vault::rgb(224, 104, 104);
const std::uint32_t kBlack = vault::rgb(8, 10, 16);

int text_width(const char *text, int scale)
{
    return static_cast<int>(text_length(text)) * 6 * scale;
}

void draw_right(const vault::Canvas &canvas, int right, int y, const char *text, int scale,
                std::uint32_t color)
{
    canvas.text(right - text_width(text, scale), y, text, scale, color);
}

void draw_centered(const vault::Canvas &canvas, int center, int y, const char *text, int scale,
                   std::uint32_t color)
{
    canvas.text(center - text_width(text, scale) / 2, y, text, scale, color);
}

void draw_wrapped(const vault::Canvas &canvas, int x, int y, const char *text, int scale,
                  int max_characters, int max_lines, std::uint32_t color)
{
    char line[64];
    int line_length = 0;
    int lines = 0;
    const char *at = text;
    while (*at && lines < max_lines)
    {
        while (*at == ' ')
        {
            ++at;
        }
        const char *word = at;
        int word_length = 0;
        while (at[word_length] && at[word_length] != ' ')
        {
            ++word_length;
        }
        if (line_length > 0 && line_length + 1 + word_length > max_characters)
        {
            line[line_length] = '\0';
            canvas.text(x, y + lines * (8 * scale), line, scale, color);
            ++lines;
            line_length = 0;
        }
        if (word_length > max_characters)
        {
            word_length = max_characters;
        }
        if (line_length > 0)
        {
            line[line_length++] = ' ';
        }
        for (int index = 0; index < word_length && line_length < max_characters; ++index)
        {
            line[line_length++] = word[index];
        }
        at = word + word_length;
        while (*at == ' ')
        {
            ++at;
        }
    }
    if (line_length > 0 && lines < max_lines)
    {
        line[line_length] = '\0';
        canvas.text(x, y + lines * (8 * scale), line, scale, color);
    }
}

const char *kind_label(const Game &game)
{
    if (game.installed)
    {
        return "INST";
    }
    if (game.pkg)
    {
        return "PKG";
    }
    return "DUMP";
}

void draw(const vault::Canvas &canvas)
{
    canvas.clear(kBackground);

    canvas.rect(0, 0, 1920, 132, kPanel);
    canvas.rect(0, 0, 1920, 6, kAccent);
    canvas.text(56, 34, "PROSPERO VAULT", 6, kText);
    canvas.text(60, 96, "NATIVE TITLE  /  PS5 13.20  /  VIDEOOUT", 2, kDim);

    if (g_state.backend)
    {
        draw_right(canvas, 1864, 40, g_state.scanning ? "SCANNING" : "BACKEND ONLINE", 2,
                   g_state.scanning ? kAccent : kGreen);
        char count[40];
        char *limit = count + sizeof count;
        char *at = count;
        at = append_uint(at, limit, static_cast<unsigned long long>(g_state.count));
        at = append_text(at, limit, " TITLES");
        draw_right(canvas, 1864, 78, count, 2, kDim);
    }
    else
    {
        draw_right(canvas, 1864, 40, "BACKEND OFFLINE", 2, kRed);
        draw_right(canvas, 1864, 78, "PORT 8097", 2, kDim);
    }

    // Library panel
    canvas.rect(48, 160, 1180, 760, kPanel);
    canvas.rect(48, 160, 1180, 2, kLine);
    canvas.text(76, 184, "LIBRARY", 3, kAccent);
    draw_right(canvas, 1204, 190, "DPAD TO BROWSE", 2, kDim);

    if (g_state.count == 0)
    {
        draw_centered(canvas, 638, 470, "NO TITLES YET", 4, kDim);
        draw_centered(canvas, 638, 540, "PRESS SQUARE TO SCAN THE CONSOLE", 2, kDim);
    }
    else
    {
        const int rows = 10;
        for (int row = 0; row < rows; ++row)
        {
            const int index = g_state.scroll + row;
            if (index >= g_state.count)
            {
                break;
            }
            const Game &game = g_state.games[index];
            const int y = 238 + row * 68;
            if (index == g_state.selected)
            {
                canvas.rect(64, y - 8, 1148, 62, kPanelRaised);
                canvas.rect(64, y - 8, 6, 62, kAccent);
            }

            char number[8];
            format_uint(number, sizeof number, static_cast<unsigned long long>(index + 1));
            canvas.text(88, y + 8, number, 2, index == g_state.selected ? kAccent : kDim);

            canvas.rect(136, y, 72, 38, index == g_state.selected ? kAccent : kLine);
            draw_centered(canvas, 172, y + 10, kind_label(game), 2,
                          index == g_state.selected ? kBlack : kText);

            char name[72];
            uppercase(name, sizeof name, game.name);
            name[60] = '\0';
            canvas.text(232, y + 4, name, 2, kText);

            char meta[64];
            char *limit = meta + sizeof meta;
            char *at = meta;
            at = append_text(at, limit, game.platform);
            at = append_text(at, limit, "   ");
            at = append_text(at, limit, game.size_label);
            if (game.installed)
            {
                at = append_text(at, limit, "   INSTALLED");
            }
            canvas.text(232, y + 26, meta, 1, game.installed ? kGreen : kDim);

            if (index == g_state.selected)
            {
                draw_right(canvas, 1196, y + 10, "SELECTED", 2, kTeal);
            }
        }
        draw_right(canvas, 1204, 884, g_state.playing ? "A GAME IS RUNNING" : "READY", 2,
                   g_state.playing ? kAccent : kDim);
    }

    // Details panel
    canvas.rect(1256, 160, 616, 760, kPanel);
    canvas.rect(1256, 160, 616, 2, kLine);
    canvas.text(1284, 184, "SELECTED", 3, kAccent);

    if (g_state.count > 0)
    {
        const Game &game = g_state.games[g_state.selected];
        char name[128];
        uppercase(name, sizeof name, game.name);
        draw_wrapped(canvas, 1284, 240, name, 3, 24, 4, kText);

        canvas.rect(1284, 400, 560, 2, kLine);
        canvas.text(1284, 424, "FORMAT", 2, kDim);
        canvas.text(1480, 424, kind_label(game), 2, kText);
        canvas.text(1284, 464, "PLATFORM", 2, kDim);
        canvas.text(1480, 464, game.platform, 2, kText);
        canvas.text(1284, 504, "SIZE", 2, kDim);
        canvas.text(1480, 504, game.size_label, 2, kText);
        canvas.text(1284, 544, "STATE", 2, kDim);
        canvas.text(1480, 544, game.installed ? "INSTALLED" : "AVAILABLE", 2,
                    game.installed ? kGreen : kAccent);
        canvas.text(1284, 584, "TITLE ID", 2, kDim);
        canvas.text(1480, 584, game.id, 2, kText);

        // Action rows
        const int action_y[3] = {690, 758, 826};
        const char *keys[3] = {"X", "SQ", "TR"};
        const char *labels[3] = {"PLAY / INSTALL", "SCAN LIBRARY", "REFRESH LIST"};
        for (int action = 0; action < 3; ++action)
        {
            canvas.rect(1284, action_y[action], 56, 44, kAccent);
            draw_centered(canvas, 1312, action_y[action] + 14, keys[action], 2, kBlack);
            canvas.text(1360, action_y[action] + 14, labels[action], 2, kText);
        }
    }

    if (g_state.status[0])
    {
        draw_wrapped(canvas, 1284, 896, g_state.status, 1, 58, 2, kTeal);
    }

    // Footer
    canvas.rect(0, 1000, 1920, 80, kPanel);
    canvas.rect(0, 1000, 1920, 2, kLine);
    draw_centered(canvas, 960, 1028,
                  "DPAD MOVE   X PLAY   SQUARE SCAN   TRIANGLE REFRESH   L1/R1 PAGE   CIRCLE STATUS",
                  2, kDim);
    draw_right(canvas, 1872, 1028, "NATIVE  /  8096", 2, kTeal);

    if (g_state.frames == 1)
    {
        log_text("vault-native: first frame drawn\n");
    }
}
} // namespace

int main()
{
    log_text("vault-native: boot\n");
    const int net = sceNetInit();
    char line[64];
    char *limit = line + sizeof line;
    char *at = line;
    at = append_text(at, limit, "vault-native: sceNetInit ");
    at = append_uint(at, limit, static_cast<unsigned long long>(static_cast<unsigned>(net)));
    at = append_text(at, limit, "\n");
    log_text(line);

    sceUserServiceInitialize(nullptr);
    scePadInit();

    fetch_library();
    status_start();

    vault::run(draw, tick);
    return 0;
}
