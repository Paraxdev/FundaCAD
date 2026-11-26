// FundaCAD: replaces the boost::adjacency_list and boost::connected_components pair GCS.cpp used. Components are
// numbered in the order of their lowest vertex, the order boost's DFS assigns them, so the solver's subsystem split
// is the same as FreeCAD's.
#ifndef FC_COMPONENTS_H
#define FC_COMPONENTS_H

#include <vector>

namespace fc
{
class Components
{
public:
    void add_vertex()
    {
        parent.push_back(int(parent.size()));
    }
    void add_edge(int a, int b)
    {
        int ra = find(a), rb = find(b);
        if (ra != rb) {
            if (ra < rb) {
                parent[rb] = ra;
            }
            else {
                parent[ra] = rb;
            }
        }
    }
    std::size_t num_vertices() const
    {
        return parent.size();
    }
    int connected_components(int* out)
    {
        std::vector<int> label(parent.size(), -1);
        int next = 0;
        for (int v = 0; v < int(parent.size()); v++) {
            int r = find(v);
            if (label[r] < 0) {
                label[r] = next++;
            }
            out[v] = label[r];
        }
        return next;
    }

private:
    std::vector<int> parent;
    int find(int v)
    {
        while (parent[v] != v) {
            parent[v] = parent[parent[v]];
            v = parent[v];
        }
        return v;
    }
};
}  // namespace fc

#endif
