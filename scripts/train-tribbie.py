# -*- coding: utf-8 -*-
"""缇宝 GPT-SoVITS v2 微调训练：预处理 3 步 + S1 训练 + S2 训练。

用法（在 E:\\qqtools\\GPT-SoVITS 目录下，用 venv310 python 跑）:
  python E:\\qq-project\\deepseek-harness\\qq-bridge-src\\scripts\\train-tribbie.py \
      --list E:\\qq-project\\deepseek-harness\\qq-bridge-src\\data\\voice\\tribbie\\train-fixed.list \
      [--phase preprocess|s1|s2|all] [--epochs 8] [--batch-s1 8] [--batch-s2 8]

list 格式：每行 `音频绝对路径|说话人|语言|文本`
"""
import argparse, json, os, subprocess, sys, yaml

GSV_ROOT = os.path.dirname(os.path.abspath(__file__))
if not os.path.exists(os.path.join(GSV_ROOT, "GPT_SoVITS")):
    # 脚本在 qq-bridge-src/scripts，GSV 在 <本机路径>\GPT-SoVITS
    GSV_ROOT = r"<本机路径>\GPT-SoVITS"

PY = r"<本机路径>\venv310\Scripts\python.exe"
WAV_DIR = r"<本机路径>\Downloads\崩坏星穹铁道语音包3.8（中）\崩坏星穹铁道语音包3.8（中）\缇宝"
EXP = "tribbie"
OPT_DIR = os.path.join(GSV_ROOT, "logs", EXP)
VERSION = "v2"
BERT = "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
CNHUBERT = "GPT_SoVITS/pretrained_models/chinese-hubert-base"
S1_PRETRAINED = "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
S2G_PRETRAINED = "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth"
S2D_PRETRAINED = "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2D2333k.pth"
S2_CONFIG = "GPT_SoVITS/configs/s2.json"
S1_TEMPLATE = "GPT_SoVITS/configs/s1longer-v2.yaml"


def base_env():
    e = dict(os.environ)
    # webui.py 会写 users.pth 把这些目录加入 sys.path；直接跑脚本时没 users.pth，
    # 这里用 PYTHONPATH 补齐（text/feature_extractor 等模块依赖 GSV_ROOT/GPT_SoVITS）。
    py_path = os.pathsep.join([
        GSV_ROOT,
        os.path.join(GSV_ROOT, "GPT_SoVITS"),
        os.path.join(GSV_ROOT, "GPT_SoVITS", "BigVGAN"),
        os.path.join(GSV_ROOT, "tools"),
        os.path.join(GSV_ROOT, "tools", "asr"),
        os.path.join(GSV_ROOT, "tools", "uvr5"),
    ])
    e.update({
        "i_part": "0",
        "all_parts": "1",
        "_CUDA_VISIBLE_DEVICES": "0",
        "is_half": "True",
        "version": VERSION,
        "PYTHONPATH": py_path + os.pathsep + e.get("PYTHONPATH", ""),
        "PYTHONIOENCODING": "utf-8",
    })
    return e


def run(cmd, env, label):
    print(f"\n=== {label} ===\n$ {cmd}", flush=True)
    r = subprocess.run(cmd, shell=True, cwd=GSV_ROOT, env=env)
    if r.returncode != 0:
        print(f"[FAIL] {label} exit={r.returncode}", flush=True)
        sys.exit(r.returncode)
    print(f"[OK] {label}", flush=True)


def merge_parts(opt_dir):
    """把 -0 分片文件合并成无后缀文件（单 GPU 时只有 -0）。"""
    for base in ["2-name2text", "6-name2semantic"]:
        part = os.path.join(opt_dir, f"{base}-0.txt") if base == "2-name2text" else os.path.join(opt_dir, f"{base}-0.tsv")
        target = os.path.join(opt_dir, f"{base}.txt") if base == "2-name2text" else os.path.join(opt_dir, f"{base}.tsv")
        if os.path.exists(part):
            with open(part, "r", encoding="utf8") as f:
                content = f.read()
            with open(target, "w", encoding="utf8") as f:
                f.write(content)
            os.remove(part)
            print(f"[merge] {part} -> {target}")


def preprocess(list_path):
    env = base_env()
    env.update({
        "inp_text": list_path,
        "inp_wav_dir": WAV_DIR,
        "exp_name": EXP,
        "opt_dir": OPT_DIR,
        "bert_pretrained_dir": BERT,
        "cnhubert_base_dir": CNHUBERT,
        "pretrained_s2G": S2G_PRETRAINED,
        "s2config_path": S2_CONFIG,
    })
    run(f'"{PY}" -s GPT_SoVITS/prepare_datasets/1-get-text.py', env, "1-get-text (文本/BERT)")
    run(f'"{PY}" -s GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py', env, "2-get-hubert-wav32k (Hubert/wav32k)")
    run(f'"{PY}" -s GPT_SoVITS/prepare_datasets/3-get-semantic.py', env, "3-get-semantic (语义token)")
    merge_parts(OPT_DIR)


def train_s1(epochs, batch):
    s1_dir = OPT_DIR
    os.makedirs(os.path.join(GSV_ROOT, "GPT_weights_v2"), exist_ok=True)
    with open(os.path.join(GSV_ROOT, S1_TEMPLATE), "r", encoding="utf8") as f:
        data = yaml.load(f, Loader=yaml.FullLoader)
    os.makedirs(os.path.join(s1_dir, "logs_s1"), exist_ok=True)
    data["train"]["batch_size"] = batch
    data["train"]["epochs"] = epochs
    data["train"]["save_every_n_epoch"] = 1
    data["train"]["if_save_every_weights"] = True
    data["train"]["if_save_latest"] = True
    data["train"]["if_dpo"] = False
    data["train"]["half_weights_save_dir"] = "GPT_weights_v2"
    data["train"]["exp_name"] = EXP
    data["pretrained_s1"] = S1_PRETRAINED
    data["train_semantic_path"] = f"{s1_dir}/6-name2semantic.tsv"
    data["train_phoneme_path"] = f"{s1_dir}/2-name2text.txt"
    data["output_dir"] = f"{s1_dir}/logs_s1_v2"
    cfg_path = os.path.join(GSV_ROOT, "tmp_s1_tribbie.yaml")
    with open(cfg_path, "w", encoding="utf8") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)
    env = base_env()
    env["hz"] = "25hz"
    run(f'"{PY}" -s GPT_SoVITS/s1_train.py --config_file "{cfg_path}"', env, f"S1 训练 (epochs={epochs}, batch={batch})")


def train_s2(epochs, batch):
    s2_dir = OPT_DIR
    os.makedirs(os.path.join(GSV_ROOT, "SoVITS_weights_v2"), exist_ok=True)
    with open(os.path.join(GSV_ROOT, S2_CONFIG), "r", encoding="utf8") as f:
        data = json.load(f)
    os.makedirs(f"{s2_dir}/logs_s2_{VERSION}", exist_ok=True)
    data["train"]["batch_size"] = batch
    data["train"]["epochs"] = epochs
    data["train"]["text_low_lr_rate"] = 0.4
    data["train"]["pretrained_s2G"] = S2G_PRETRAINED
    data["train"]["pretrained_s2D"] = S2D_PRETRAINED
    data["train"]["if_save_latest"] = True
    data["train"]["if_save_every_weights"] = True
    data["train"]["save_every_epoch"] = 1
    data["train"]["gpu_numbers"] = "0"
    data["train"]["grad_ckpt"] = False
    data["train"]["lora_rank"] = 32
    data["model"]["version"] = VERSION
    data["data"]["exp_dir"] = data["s2_ckpt_dir"] = s2_dir
    data["save_weight_dir"] = "SoVITS_weights_v2"
    data["name"] = EXP
    data["version"] = VERSION
    cfg_path = os.path.join(GSV_ROOT, "tmp_s2_tribbie.json")
    with open(cfg_path, "w", encoding="utf8") as f:
        json.dump(data, f)
    run(f'"{PY}" -s GPT_SoVITS/s2_train.py --config "{cfg_path}"', base_env(), f"S2 训练 (epochs={epochs}, batch={batch})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", required=True)
    ap.add_argument("--phase", default="all", choices=["preprocess", "s1", "s2", "all"])
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch-s1", type=int, default=8)
    ap.add_argument("--batch-s2", type=int, default=8)
    a = ap.parse_args()
    if a.phase in ("preprocess", "all"):
        preprocess(a.list)
    if a.phase in ("s1", "all"):
        train_s1(a.epochs, a.batch_s1)
    if a.phase in ("s2", "all"):
        train_s2(a.epochs, a.batch_s2)
    print("\n全部完成。")
