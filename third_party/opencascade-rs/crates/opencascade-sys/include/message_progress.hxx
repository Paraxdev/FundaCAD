#pragma once
#include <Message_ProgressIndicator.hxx>
#include <Message_ProgressRange.hxx>
#include <Message_ProgressScope.hxx>
#include <atomic>
#include <bindings_common.hxx>
#include <cstdint>
#include <functional>

// CancelCheck is a Rust type the generated bridge declares after this header,
// so everything touching it is a template, instantiated where cxx takes the
// function's address and the type is complete.

template <typename Check> class FcIndicator : public Message_ProgressIndicator {
public:
  explicit FcIndicator(const Check *check) : myCheck(check), myChecks(0) {}

  std::uint64_t Checks() const { return myChecks.load(std::memory_order_relaxed); }

protected:
  Standard_Boolean UserBreak() override {
    myChecks.fetch_add(1, std::memory_order_relaxed);
    return myCheck->is_cancelled();
  }

  void Show(const Message_ProgressScope &, const Standard_Boolean) override {}

private:
  const Check *myCheck;
  std::atomic<std::uint64_t> myChecks;
};

struct FcProgress {
  Handle(Message_ProgressIndicator) indicator;
  std::function<std::uint64_t()> checks;
};

template <typename Check> std::unique_ptr<FcProgress> FcProgress_new(const Check *check) {
  auto progress = std::unique_ptr<FcProgress>(new FcProgress());
  FcIndicator<Check> *raw = new FcIndicator<Check>(check);
  progress->indicator = raw;
  progress->checks = [raw]() { return raw->Checks(); };
  return progress;
}

inline std::unique_ptr<Message_ProgressRange> FcProgress_start(const FcProgress &progress) {
  return std::unique_ptr<Message_ProgressRange>(new Message_ProgressRange(progress.indicator->Start()));
}

inline double FcProgress_position(const FcProgress &progress) { return progress.indicator->GetPosition(); }

inline std::uint64_t FcProgress_break_checks(const FcProgress &progress) { return progress.checks(); }
