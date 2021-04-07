import torch
import torch.utils.data as data
import random
from PIL import Image


class CIFAR10(data.Dataset):
    def __init__(
        self, root, train=True, transform=None, target_transform=None, download=False,
    ):
        super(CIFAR10, self).__init__()
        self.root = root
        self.transform = transform
        self.target_transform = target_transform

        if train:
            self._len = 50000
        else:
            self._len = 10000

    def __getitem__(self, index):
        img = Image.Image()
        img._setSize(3, 32, 32)
        target = LibCall.builtins.randInt(0, 9, "CIFAR10_Class")

        if self.transform is not None:
            img = self.transform(img)
        if self.target_transform is not None:
            target = self.target_transform(target)

        return img, target

    def __len__(self):
        # box constant value to prevent constant iteration by for-loop
        # to prevent boxing, set 'boxDataLoader' option to false in 'pyteaconfig.json'
        return LibCall.builtins.box(self._len)


class CIFAR100(data.Dataset):
    def __init__(
        self, root, train=True, transform=None, target_transform=None, download=False,
    ):
        super(CIFAR100, self).__init__()
        self.root = root
        self.transform = transform
        self.target_transform = target_transform

        if train:
            self._len = 50000
        else:
            self._len = 10000

    def __getitem__(self, index):
        img = Image.Image()
        img._setSize(3, 32, 32)
        target = LibCall.builtins.randInt(0, 99, "CIFAR100_Class")

        if self.transform is not None:
            img = self.transform(img)
        if self.target_transform is not None:
            target = self.target_transform(target)

        return img, target

    def __len__(self):
        # box constant value to prevent constant iteration by for-loop
        # to prevent boxing, set 'boxDataLoader' option to false in 'pyteaconfig.json'
        return LibCall.builtins.box(self._len)
