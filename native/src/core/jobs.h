// A small worker thread pool (terrain and vegetation are generated off the main thread).
// On Switch: 3 cores are available to games; the pool takes (cores - 1) workers.
#pragma once
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>
#include <algorithm>

namespace sl {

class JobSystem {
public:
  explicit JobSystem(int threads = 0) {
    if (threads <= 0) threads = std::max(1, int(std::thread::hardware_concurrency()) - 1);
    for (int i = 0; i < threads; i++) workers_.emplace_back([this] { run(); });
  }
  ~JobSystem() {
    { std::lock_guard<std::mutex> l(m_); stop_ = true; }
    cv_.notify_all();
    for (auto& t : workers_) t.join();
  }
  void push(std::function<void()> job) {
    { std::lock_guard<std::mutex> l(m_); q_.push_back(std::move(job)); pending_++; }
    cv_.notify_one();
  }
  int pending() const { return pending_.load(); }
  int threads() const { return int(workers_.size()); }

private:
  void run() {
    for (;;) {
      std::function<void()> job;
      {
        std::unique_lock<std::mutex> l(m_);
        cv_.wait(l, [this] { return stop_ || !q_.empty(); });
        if (stop_ && q_.empty()) return;
        job = std::move(q_.front());
        q_.pop_front();
      }
      job();
      pending_--;
    }
  }
  std::vector<std::thread> workers_;
  std::deque<std::function<void()>> q_;
  std::mutex m_;
  std::condition_variable cv_;
  std::atomic<int> pending_{0};
  bool stop_ = false;
};

} // namespace sl
