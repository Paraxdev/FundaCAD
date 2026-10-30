#pragma once
#include "rust/cxx.h"
#include <NCollection_List.hxx>
#include <Standard_Failure.hxx>
#include <exception>
#include <memory>
#include <string>

// cxx maps a throw to Err only for std::exception, and OCCT throws
// Standard_Failure, which would otherwise unwind through an extern "C" frame
// and abort. cxx picks this overload up for every function declared -> Result.
namespace rust {
namespace behavior {
template <typename Try, typename Fail> static void trycatch(Try &&func, Fail &&fail) noexcept try {
  func();
} catch (const Standard_Failure &e) {
  std::string message = e.DynamicType()->Name();
  const char *detail = e.GetMessageString();
  if (detail != nullptr && *detail != '\0') {
    message += ": ";
    message += detail;
  }
  fail(message.c_str());
} catch (const std::exception &e) {
  fail(e.what());
} catch (...) {
  fail("unknown C++ exception");
}
} // namespace behavior
} // namespace rust

// Generic template constructor
template <typename T, typename... Args> std::unique_ptr<T> construct_unique(Args... args) {
  return std::unique_ptr<T>(new T(args...));
}

// Type casting
template <typename T, typename U> inline U upcast(T src) { return src; }
template <typename T, typename U> inline const U &upcast_ref(const T &src) { return src; }

// Generic List. Copied item by item: GCC 15's C++20 vector range constructor
// measures the range with operator-, which OCCT's list iterator only declares
// and static asserts on.
template <typename T> std::unique_ptr<std::vector<T>> list_to_vector(const NCollection_List<T> &list) {
  auto out = std::make_unique<std::vector<T>>();
  out->reserve(list.Size());
  for (const T &item : list) {
    out->push_back(item);
  }
  return out;
}

template <typename T> const T &handle_try_deref(const opencascade::handle<T> &handle) {
  if (handle.IsNull()) {
    throw std::runtime_error("null handle dereference");
  }
  return *handle;
}
