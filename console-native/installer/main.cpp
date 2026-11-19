// Prospero Vault title installer payload.
//
// The console's file manager is a separate process and can be down. This
// payload is the fallback: it pulls an uncompressed tar of the title folder
// from the Mac and writes it to /data/homebrew with the 0777 modes
// ShadowMountPlus requires.

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

extern "C"
{
    int sceLncUtilInitialize();
    int sceLncUtilGetAppIdOfRunningBigApp();
    int sceLncUtilGetAppTitleId(unsigned int app_id, char *title_id);
    int sceLncUtilKillApp(unsigned int app_id);
}

namespace
{
constexpr const char *kRoot = "/data/homebrew/PVLT00001";

bool write_all(int fd, const char *data, std::size_t size)
{
    while (size > 0)
    {
        const ssize_t written = ::write(fd, data, size);
        if (written <= 0)
        {
            return false;
        }
        data += written;
        size -= static_cast<std::size_t>(written);
    }
    return true;
}

void make_parents(const char *path)
{
    char buffer[512];
    std::snprintf(buffer, sizeof buffer, "%s", path);
    for (char *p = buffer + 1; *p; ++p)
    {
        if (*p != '/')
        {
            continue;
        }
        *p = '\0';
        ::mkdir(buffer, 0777);
        *p = '/';
    }
}

bool store_file(const char *relative, const char *data, std::size_t size)
{
    char path[512];
    std::snprintf(path, sizeof path, "%s/%s", kRoot, relative);
    make_parents(path);
    const int fd = ::open(path, O_CREAT | O_WRONLY | O_TRUNC, 0777);
    if (fd < 0)
    {
        std::printf("installer: open failed: %s\n", path);
        return false;
    }
    const bool ok = write_all(fd, data, size);
    ::close(fd);
    ::chmod(path, 0777);
    std::printf("installer: %s (%zu bytes) %s\n", path, size, ok ? "ok" : "short write");
    return ok;
}
} // namespace

extern "C"
{
    extern const unsigned char title_tar[];
    extern const unsigned char title_tar_end[];
}

int main()
{
    // A running title keeps its old eboot mapped and LNC holds the app slot.
    // Stop it first so the next launch picks up the files written here.
    sceLncUtilInitialize();
    const int running = sceLncUtilGetAppIdOfRunningBigApp();
    if (running >= 0)
    {
        char title[32] = {0};
        sceLncUtilGetAppTitleId(static_cast<unsigned int>(running), title);
        if (std::strcmp(title, "PVLT00001") == 0)
        {
            std::printf("installer: stopping running title 0x%08x\n", running);
            sceLncUtilKillApp(static_cast<unsigned int>(running));
            sleep(3);
        }
    }

    ::mkdir("/data/homebrew", 0777);
    ::mkdir(kRoot, 0777);

    const char *tar = reinterpret_cast<const char *>(title_tar);
    const std::size_t used = static_cast<std::size_t>(title_tar_end - title_tar);
    const char *cursor = tar;
    const char *end = tar + used;
    std::printf("installer: embedded tar %zu bytes\n", used);

    int files = 0;
    while (cursor + 512 <= end)
    {
        char name[101] = {0};
        std::memcpy(name, cursor, 100);
        if (name[0] == '\0')
        {
            break;
        }

        char size_text[13] = {0};
        std::memcpy(size_text, cursor + 124, 12);
        const std::size_t size = std::strtoul(size_text, nullptr, 8);
        const char type = cursor[156];
        const char *data = cursor + 512;

        if (data + size > end)
        {
            std::printf("installer: truncated entry %s\n", name);
            break;
        }

        const char *relative = name;
        if (std::strncmp(relative, "PVLT00001/", 10) == 0)
        {
            relative += 10;
        }
        if (relative[0] != '\0')
        {
            if (type == '5')
            {
                char path[512];
                std::snprintf(path, sizeof path, "%s/%s", kRoot, relative);
                make_parents(path);
                ::mkdir(path, 0777);
                ::chmod(path, 0777);
            }
            else if (type == '0' || type == '\0')
            {
                if (store_file(relative, data, size))
                {
                    ++files;
                }
            }
        }

        cursor = data + ((size + 511) / 512) * 512;
    }

    std::printf("installer: wrote %d files\n", files);
    return files > 0 ? 0 : 1;
}
