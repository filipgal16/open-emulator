CC       ?= gcc
CFLAGS   ?= -O2 -Wall -Wextra -Werror -std=c11 -Iinclude
LDFLAGS  ?=

BUILD    := build
BIN      := $(BUILD)/open-vmm
GUEST    := $(BUILD)/guest/hello.bin

SRC      := src/main.c src/vmm.c src/serial.c src/x86_soft.c
OBJ      := $(patsubst src/%.c,$(BUILD)/%.o,$(SRC))

.PHONY: all clean test run guest \
	android-fetch android-setup android-run android \
	android-provision android-start android-stop android-status android-doctor android-bench \
	desktop-install desktop-dev desktop-build

all: $(BIN) $(GUEST)

# Guest profile: `fast` (AOSP, no Play Services — quickest boot) or `full` (Google APIs).
# Override per invocation, e.g.  make android-setup ANDROID_PROFILE=full
ANDROID_PROFILE ?= fast
export ANDROID_PROFILE

android-fetch:
	./android/scripts/fetch_android.sh

android-setup:
	./android/scripts/setup_avd.sh

# --cold is deliberate here and nowhere else: provisioning must start from a known-clean boot
# before it saves the snapshot every later start loads.
android-provision:
	ANDROID_HEADLESS=1 ./android/bin/open-emu start --cold
	ANDROID_HEADLESS=1 ./android/bin/open-emu provision

android-start:
	ANDROID_HEADLESS=1 ./android/bin/open-emu start

android-stop:
	./android/bin/open-emu stop

android-status:
	./android/bin/open-emu status

android-doctor:
	./android/bin/open-emu doctor

android-run:
	ANDROID_HEADLESS=1 ./android/bin/open-emu demo

android-bench:
	ANDROID_HEADLESS=1 ./android/scripts/bench_realtime.sh

android: android-fetch android-setup android-provision android-start

desktop-install:
	cd desktop && npm install

desktop-dev:
	cd desktop && npm run dev

desktop-build:
	cd desktop && npm run build

desktop-test:
	cd desktop && npm test

$(BIN): $(OBJ) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $(OBJ) $(LDFLAGS)

$(BUILD)/%.o: src/%.c include/*.h | $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(GUEST): scripts/assemble_guest.py guest/hello.asm | $(BUILD)/guest
	python3 scripts/assemble_guest.py

$(BUILD) $(BUILD)/guest:
	mkdir -p $@

run: all
	./$(BIN) --backend=soft $(GUEST)

test: all
	@./scripts/smoke_test.sh

clean:
	rm -rf $(BUILD)
