// Scripture Armor v2 battery fixture — clean control: bounded copies,
// one command call on a compile-time literal. The scan must NOT flag
// sink-reachability (literal argument only) and should pass.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
    char buf[256];
    if (argc > 1) {
        strncpy(buf, argv[1], sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = '\0';
        printf("got: %s\n", buf);
    }
    system("echo hello");              // literal-only — reachability is low
    return 0;
}
