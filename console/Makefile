# Prospero Vault console payload.
#
#   make -C console          # builds build/prospero-vault.elf
#   make -C console clean
#
# The UI is embedded into the ELF, so the payload has no runtime file
# dependencies: one file to copy to the console, one thing to load.
#
# Override the SDK if yours lives elsewhere:
#   make -C console PS5_PAYLOAD_SDK=/path/to/ps5-payload-sdk

PS5_PAYLOAD_SDK ?= $(HOME)/ps5-harness/.deps/ps5-payload-sdk
BUILD_DIR       ?= build
BUILD_ID        ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo nogit)

HAVE_SDK := $(wildcard $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk)

# The SDK's compiler wrappers shell out to llvm-config to find the host LLVM.
LLVM_CONFIG ?= $(wildcard /opt/homebrew/opt/llvm/bin/llvm-config)
export LLVM_CONFIG

ifneq ($(HAVE_SDK),)
include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk
endif

CXXFLAGS += -std=c++17 -O2 -Wall -Wextra -DPV_BUILD_ID=\"$(BUILD_ID)\" -DPV_HAVE_SONY=1

# Sony's launcher and user-service entry points. The SDK ships them as link
# stubs; the console binds them at load time. libSceAppInstUtil is deliberately
# not here: the 13.20 loader crashes mapping it into a payload process, so
# installs are handed to the local installer service over HTTP.
LDLIBS += -lSceSystemService -lSceUserService

ELF      := $(BUILD_DIR)/prospero-vault.elf
UI_CPP   := $(BUILD_DIR)/ui_data.cpp
UI_SRC   := ui/index.html
ICON_CPP := $(BUILD_DIR)/icon_data.cpp
ICON_SRC := ui/icon0.png

all: $(ELF)

$(UI_CPP): $(UI_SRC) tools/embed.py
	@mkdir -p $(BUILD_DIR)
	python3 tools/embed.py $(UI_SRC) $@ kIndexHtml

# The home-screen tile is drawn by tools/icon.py and embedded, so the payload
# carries its own icon and there is no second file to copy to the console.
$(ICON_CPP): $(ICON_SRC) tools/embed.py
	@mkdir -p $(BUILD_DIR)
	python3 tools/embed.py $(ICON_SRC) $@ kIconPng

$(ELF): main.cpp $(UI_CPP) $(ICON_CPP)
	@if [ -z "$(HAVE_SDK)" ]; then \
		echo "console: payload SDK not found at $(PS5_PAYLOAD_SDK)" >&2; \
		exit 1; \
	fi
	$(CXX) $(CXXFLAGS) -o $@ main.cpp $(UI_CPP) $(ICON_CPP) $(LDLIBS)
	@echo "console: built $@"
	@ls -l $@

host-check: main.cpp
	$(CXX) -std=c++17 -O0 -Wall -Wextra -fsyntax-only main.cpp
	@echo "console: syntax OK"

icon:
	python3 tools/icon.py $(ICON_SRC)

clean:
	rm -rf $(BUILD_DIR)

.PHONY: all host-check icon clean
