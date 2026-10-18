import sys
import numpy as np

try:
    import tflite_runtime.interpreter as tflite
except ImportError:
    import ai_edge_litert.interpreter as tflite

delegate = tflite.load_delegate("libedgetpu.so.1")
interpreter = tflite.Interpreter("models/yolo26n_full_integer_quant_edgetpu.tflite", experimental_delegates=[delegate])
interpreter.allocate_tensors()
inp = interpreter.get_input_details()[0]
interpreter.set_tensor(inp["index"], np.zeros(inp["shape"], dtype=inp["dtype"]))
interpreter.invoke()
print("SUCCESSFULLY INVOKED EDGE TPU ON ZERO TENSOR IN WSL!")
