// Scripture Armor v2 battery fixture — DELIBERATELY dangerous shape:
// unbounded copies of attacker input + command execution on a
// non-literal buffer. The scan MUST flag sink-reachability (critical)
// and unbounded-copy-call (medium).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
    char buf[256];
    char cmd[512];
    if (argc > 1) {
        strcpy(buf, argv[1]);          // unbounded copy of tainted input
        sprintf(cmd, "echo %s", buf);  // command string built from input
        system(cmd);                   // executes tainted data — critical
    }
    return 0;
}
