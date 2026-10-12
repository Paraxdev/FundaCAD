# Stress

Every functional print raises the same question sooner or later: will this part hold. With Stress you say where the part is held and where it is pushed, and FundaCAD shows how it bends and where the material is working hardest. It suits brackets, hooks, clips and anything else that carries a load.

Open Inspect on the rail and pick Stress. The panel works on one body at a time.

## An example

Say you have a wall bracket with two screw holes and a shelf face that will carry a book.

1. Choose the bracket in the Body list at the top of the panel.
2. Under Support 1, press Place and click the body near a screw hole. Press Add support and do the same for the other hole.
3. Under Load 1, leave the kind on Force, press Place and click the shelf face. Type 50 in Force and leave Direction on Into the face.
4. Pick the material you will print in, such as PETG.
5. Press Run.

When the run finishes, the part is coloured by stress and the panel switches to the results.

<!-- shot: stress-bracket | A bracket coloured from blue to red by stress, with the setup folded away and the results list visible -->

## Supports and loads

A support is a place where the part cannot move. Without one, the part has nothing to push against.

Each support has a type. Fixed holds the part in every direction, like a part glued to a wall. Pinned is a hole with a pin through it, held in place but free to turn. Slider holds the part against a face but lets it slide along it.

Place lets you click the body where it is held, so the spot does not need a face of its own. Each click puts down an orb, and you can drag its rim to change its size or type the radius in the panel. Shift-click places several in one go. If you would rather hold a whole face, select it in the view and press From selection.

A load is a push on the part, and it is placed the same way. A Force is a number of newtons with a direction: into the face, along one of the axes, or a vector you type. You can drag the arrow of a force to aim and size it. A Pressure is spread evenly over its area and is entered in MPa.

Gravity has its own tick box and starts switched off, pointing along -Z. Switch it on when the weight of the part itself matters. A part under gravity alone is a valid study, so you can remove every load and keep only that.

## Material and mesh

The material list has PLA, PETG, ABS, ASA, PA12 nylon, PC, aluminium 6061-T6 and steel S235, and the values for the one you pick are shown under the list. Custom lets you type your own stiffness (E), Poisson's ratio, yield strength and density.

Element size sets how fine the calculation mesh is. Leave it empty and FundaCAD chooses. Smaller elements are slower and a little more exact.

## Reading the result

Once a run finishes, the setup folds away to a one-line summary, and Edit setup reopens it. The results give the peak von Mises stress and where it is, the largest deflection and where it is, the safety factor, and how the load balances against the reaction at each support.

The safety factor is the yield strength of the material divided by the peak stress. Above 1 the material should not start to give way, and below 1 the panel flags it. A printed part is weaker than the material in the table, in particular across layer lines, so leave yourself some margin and do not trust a number barely over 1.

The colour bar runs from the lowest to the highest stress. Hide colours switches the colouring off, which you need to do before you can pick faces on the body again. The Deformation slider exaggerates how far the part bends so you can see it, and Animate makes it move back and forth. Probe lets you hover the body to read the stress at a point, and a click pins a probe there.

The results are linear and approximate, and the panel says so. The calculation treats the part as a solid block that springs back, and it knows nothing about layer lines, infill or temperature. That makes it a good way to compare two designs or spot a weak neck, and a poor way to predict exactly when a printed part will break.
