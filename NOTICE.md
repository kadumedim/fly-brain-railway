# Attribution

## FlyWire connectome data

The connectome binary (`data/connectome.bin.gz`, 139,255 neurons / ~2.7M
synaptic connections) and derived metadata (`data/neuron_meta.json`) are built
from the **FlyWire FAFB v783** dataset:

> Dorkenwald, S., Matsliah, A., Sterling, A.R. et al. Neuronal wiring diagram
> of an adult brain. *Nature* 634, 124–138 (2024).
> https://doi.org/10.1038/s41586-024-07558-y

FlyWire data is released under **CC-BY-NC 4.0**
(https://creativecommons.org/licenses/by-nc/4.0/). This project is a free,
non-commercial demo. If you fork this project for commercial use, you must
remove or re-license the connectome data.

FlyWire: https://flywire.ai — a collaboration led by Princeton University
(Sebastian Seung and Mala Murthy labs), with proofreading by a worldwide
community, built on image data from the Janelia FAFB project (Zheng et al.,
2018), with synapse detection by Buhmann et al. (2021) using image alignment
by Google Research (Peter Li).

## flybrain simulation

The LIF spiking simulation (`vendor-sim/`), fly behavior logic, and fly sprite
drawing are adapted from **snedea/flybrain**
(https://github.com/snedea/flybrain), MIT license — itself adapted from the
C. elegans worm-sim lineage (Busbice, Garrett, Churchill / zrispo). See
`LICENSE` for the retained copyright notice.

## Railway

This demo drives the real Railway public GraphQL API
(https://docs.railway.com/reference/public-api) but is not affiliated with or
endorsed by Railway Corp.
