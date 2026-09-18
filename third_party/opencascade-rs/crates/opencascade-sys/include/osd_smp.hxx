#pragma once
// OpenCASCADE's shared memory parallelism, the Python engine's `occt_smp.py`: one thread pool
// feeds BRepMesh and BOPAlgo, and both take their parallel flag from a default
// this sets. Call once per process before any job, the pool must not be resized
// while an algorithm holds threads from it.

#include <BOPAlgo_Options.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <OSD_Parallel.hxx>
#include <OSD_ThreadPool.hxx>

inline int32_t osd_smp_configure(int32_t threads) {
  int n = threads > 0 ? threads : OSD_Parallel::NbLogicalProcessors();
  if (n < 1) {
    n = 1;
  }
  OSD_ThreadPool::DefaultPool(n)->Init(n);
  BRepMesh_IncrementalMesh::SetParallelDefault(true);
  BOPAlgo_Options::SetParallelMode(true);
  return static_cast<int32_t>(n);
}
