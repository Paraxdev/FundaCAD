/* The 2D Delaunay triangulation exactly as scipy.spatial.Delaunay builds it:
   Qhull 2020.2 (8.0.2, the version scipy bundles) with scipy's default options,
   the steps of scipy's qh_new_qhull_scipy and Delaunay._update, and the facet
   walk of _Qhull.get_simplex_facet_array, which swaps the first two vertices of
   a clockwise facet so every triangle comes out counter-clockwise.

   Returns 0 and fills `out` with three point indices per triangle (`*count`
   triangles, at most `cap`), or Qhull's exit code with its message in `err`. */

#include "libqhull_r/qhull_ra.h"

#include <string.h>

static void fc_read_err(FILE *f, char *err, int errlen) {
  size_t n;
  if (!f || !err || errlen <= 0) return;
  fflush(f);
  rewind(f);
  n = fread(err, 1, (size_t)(errlen - 1), f);
  err[n] = '\0';
}

int fc_delaunay_2d(const double *xy, int n, int *out, int cap, int *count, char *err, int errlen) {
  qhT qh_qh;
  qhT *qh = &qh_qh;
  int exitcode, curlong, totlong, j;
  facetT *facet;
  char cmd[] = "qhull d Qbb Qc Qz Q12 Qt";
  FILE *errfile = tmpfile();
  coordT *points;

  *count = 0;
  if (err && errlen > 0) err[0] = '\0';
  if (n <= 0) return 1;
  points = (coordT *)malloc(sizeof(coordT) * 2 * (size_t)n);
  if (!points) return qh_ERRmem;
  memcpy(points, xy, sizeof(coordT) * 2 * (size_t)n);

  qh_zero(qh, errfile ? errfile : stderr);
  qh_memcheck(qh);
  qh_initqhull_start(qh, NULL, NULL, errfile ? errfile : stderr);
  exitcode = setjmp(qh->errexit);
  if (!exitcode) {
    qh->NOerrexit = False;
    qh_initflags(qh, cmd);
    if (qh->DELAUNAY) qh->PROJECTdelaunay = True;
    qh_init_B(qh, points, n, 2, True);
    qh_qhull(qh);
    qh_check_output(qh);
    qh_prepare_output(qh);
    qh_triangulate(qh);

    j = 0;
    for (facet = qh->facet_list; facet && facet->next; facet = facet->next) {
      int i, lo = 0;
      if (facet->upperdelaunay != qh->UPPERdelaunay) continue;
      if (!facet->simplicial && qh_setsize(qh, facet->vertices) != 3) {
        exitcode = qh_ERRqhull;
        if (err && errlen > 0) snprintf(err, (size_t)errlen, "non-simplical facet encountered: %d vertices", qh_setsize(qh, facet->vertices));
        break;
      }
      if (j >= cap) {
        exitcode = qh_ERRmem;
        break;
      }
      if (facet->toporient == qh_ORIENTclock) {
        for (i = 0; i < 2; i++) {
          vertexT *vertex = (vertexT *)facet->vertices->e[i].p;
          out[3 * j + (1 ^ i)] = qh_pointid(qh, vertex->point);
        }
        lo = 2;
      }
      for (i = lo; i < 3; i++) {
        vertexT *vertex = (vertexT *)facet->vertices->e[i].p;
        out[3 * j + i] = qh_pointid(qh, vertex->point);
      }
      j++;
    }
    *count = j;
  } else {
    fc_read_err(errfile, err, errlen);
  }
  qh->NOerrexit = True;
  qh_freeqhull(qh, qh_ALL);
  qh_memfreeshort(qh, &curlong, &totlong);
  if (errfile) fclose(errfile);
  return exitcode;
}
