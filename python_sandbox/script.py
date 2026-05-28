import cv2
import numpy as np

# Load reference
ref = cv2.imread('reference_image.png')

# Let's crop the snow area under the street lamp in the reference
# The street lamp is on the right side of the image.
# Image dimensions: 4096x2680.
# The street lamp is roughly around x: 3600-3800, y: 900-1800.
# Let's crop the road under the lamp: x: 3000 to 4000, y: 1600 to 2400.
road_lamp_crop = ref[1600:2400, 3000:4000]
cv2.imwrite('output_road_lamp_crop.png', road_lamp_crop)

# Let's find the average BGR colors of:
# 1. Snow in shadow (center-left): x: 1000-1500, y: 1800-2200
shadow_snow = ref[1800:2200, 1000:1500]
avg_shadow_snow = np.mean(shadow_snow, axis=(0,1))
print("Shadow Snow Avg BGR:", avg_shadow_snow)
# In RGB: [80.18, 53.65, 69.99] -> Wait, BGR to RGB:
# Shadow Snow Avg RGB: [avg_shadow_snow[2], avg_shadow_snow[1], avg_shadow_snow[0]]
print("Shadow Snow Avg RGB:", [shadow_snow[:,:,2].mean(), shadow_snow[:,:,1].mean(), shadow_snow[:,:,0].mean()])

# 2. Snow under lamp light (mid-right): x: 3300-3600, y: 1700-2000
lamp_snow = ref[1700:2000, 3300:3600]
print("Lamp Snow Avg RGB:", [lamp_snow[:,:,2].mean(), lamp_snow[:,:,1].mean(), lamp_snow[:,:,0].mean()])

# 3. Sky near the top: x: 2000-2500, y: 200-500
sky = ref[200:500, 2000:2500]
print("Sky Avg RGB:", [sky[:,:,2].mean(), sky[:,:,1].mean(), sky[:,:,0].mean()])
