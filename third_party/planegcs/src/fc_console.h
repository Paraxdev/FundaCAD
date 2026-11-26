// FundaCAD: stands in for planegcs's emscripten Console.h, GCS logs only in debug modes and FundaCAD drops them.
#ifndef FC_CONSOLE_H
#define FC_CONSOLE_H

class Console
{
public:
    static void Log(const char*, ...)
    {}
};

#endif
